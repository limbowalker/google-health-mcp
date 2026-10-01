import { OAuth2Client } from "google-auth-library";
import type { AppConfig } from "../config.js";
import type { Store } from "../store/types.js";
import { decrypt } from "./crypto.js";

export const HEALTH_SCOPE_PREFIX = "https://www.googleapis.com/auth/googlehealth.";

export const READ_SCOPES = [
  "activity_and_fitness.readonly",
  "health_metrics_and_measurements.readonly",
  "sleep.readonly",
  "nutrition.readonly",
  "profile.readonly",
  "settings.readonly",
] as const;

export const WRITE_SCOPES = [
  "activity_and_fitness.writeonly",
  "health_metrics_and_measurements.writeonly",
  "sleep.writeonly",
  "nutrition.writeonly",
  "profile.writeonly",
  "settings.writeonly",
] as const;

export function toShortScopes(scopeString: string | undefined): string[] {
  return (scopeString ?? "")
    .split(/\s+/)
    .filter((s) => s.startsWith(HEALTH_SCOPE_PREFIX))
    .map((s) => s.slice(HEALTH_SCOPE_PREFIX.length));
}

export interface GoogleTokenResult {
  sub: string;
  email?: string;
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  /** Granted Google Health scopes, short form. */
  scopes: string[];
}

export interface GoogleOAuth {
  buildAuthUrl(opts: { state: string; codeChallenge: string; write: boolean }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokenResult>;
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number; scopes?: string[] }>;
  revoke(token: string): Promise<void>;
}

export class GoogleAuthExpiredError extends Error {
  constructor() {
    super(
      "The Google authorization for this account has expired or was revoked. " +
        "Reconnect the Google Health MCP server in your agent to sign in again.",
    );
  }
}

export class GoogleTokenError extends Error {
  constructor(
    readonly code: string,
    description: string,
  ) {
    super(`Google token endpoint error: ${code}${description ? ` (${description})` : ""}`);
  }
}

export class GoogleOAuthClient implements GoogleOAuth {
  private readonly idTokenVerifier: OAuth2Client;
  private readonly redirectUri: string;

  constructor(private readonly config: AppConfig) {
    this.idTokenVerifier = new OAuth2Client(config.googleClientId);
    this.redirectUri = new URL("/oauth/google/callback", config.baseUrl).href;
  }

  buildAuthUrl({ state, codeChallenge, write }: { state: string; codeChallenge: string; write: boolean }): string {
    const scopes = ["openid", "email", ...READ_SCOPES, ...(write ? WRITE_SCOPES : [])].map((s) =>
      s.includes(".") ? HEALTH_SCOPE_PREFIX + s : s,
    );
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      access_type: "offline",
      // Always show consent so Google issues a refresh token and the user can pick scopes.
      prompt: "consent",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokenResult> {
    const body = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.redirectUri,
    });
    if (!body.id_token) throw new Error("Google did not return an ID token; is the 'openid' scope configured?");
    const ticket = await this.idTokenVerifier.verifyIdToken({
      idToken: body.id_token,
      audience: this.config.googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) throw new Error("Google ID token has no subject");
    return {
      sub: payload.sub,
      email: payload.email_verified ? payload.email : undefined,
      accessToken: body.access_token,
      expiresIn: body.expires_in ?? 3600,
      refreshToken: body.refresh_token,
      scopes: toShortScopes(body.scope),
    };
  }

  async refresh(refreshToken: string) {
    const body = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    return {
      accessToken: body.access_token,
      expiresIn: body.expires_in ?? 3600,
      scopes: body.scope ? toShortScopes(body.scope) : undefined,
    };
  }

  async revoke(token: string) {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        ...params,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new GoogleTokenError(body.error ?? `http_${res.status}`, body.error_description ?? "");
    return body as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
      id_token?: string;
    };
  }
}

/**
 * Hands out Google access tokens per user. Access tokens are cached in memory only; the refresh
 * token is stored encrypted in the user record and refreshed on demand, as Google recommends.
 */
export class GoogleTokenManager {
  private cache = new Map<string, { token: string; expiresAt: number }>();
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly store: Store,
    private readonly oauth: GoogleOAuth,
    private readonly encryptionKey: Buffer,
  ) {}

  seed(userId: string, accessToken: string, expiresIn: number) {
    this.cache.set(userId, { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 });
  }

  invalidate(userId: string) {
    this.cache.delete(userId);
  }

  async getAccessToken(userId: string): Promise<string> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    let pending = this.inflight.get(userId);
    if (!pending) {
      pending = this.refresh(userId).finally(() => this.inflight.delete(userId));
      this.inflight.set(userId, pending);
    }
    return pending;
  }

  private async refresh(userId: string): Promise<string> {
    const user = await this.store.getUser(userId);
    if (!user?.googleRefreshTokenEnc) throw new GoogleAuthExpiredError();
    try {
      const result = await this.oauth.refresh(decrypt(user.googleRefreshTokenEnc, this.encryptionKey));
      this.seed(userId, result.accessToken, result.expiresIn);
      if (result.scopes && result.scopes.join(" ") !== user.googleScopes.join(" ")) {
        await this.store.upsertUser(userId, { googleScopes: result.scopes });
      }
      return result.accessToken;
    } catch (err) {
      if (err instanceof GoogleTokenError && err.code === "invalid_grant") {
        await this.disconnect(userId);
        throw new GoogleAuthExpiredError();
      }
      throw err;
    }
  }

  /** Forgets the Google grant and every MCP token of the user, forcing a fresh sign-in. */
  async disconnect(userId: string) {
    this.cache.delete(userId);
    await this.store.upsertUser(userId, { googleRefreshTokenEnc: null });
    await this.store.deleteTokensForUser(userId);
  }
}
