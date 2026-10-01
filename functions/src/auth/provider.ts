import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { isEmailAllowed, type AppConfig } from "../config.js";
import type { PendingAuthorization, Store } from "../store/types.js";
import { encrypt, pkceChallenge, randomToken, sha256 } from "./crypto.js";
import { READ_SCOPES, type GoogleOAuth, type GoogleTokenManager } from "./google.js";
import { consentPage, connectPage, messagePage, personalTokenPage } from "./pages.js";

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const BINDING_COOKIE = "__session"; // the only cookie Firebase Hosting forwards to functions
export const PERSONAL_TOKEN_CLIENT_ID = "personal-token";

/**
 * OAuth 2.1 authorization server for MCP clients, federating user sign-in to Google.
 *
 * Flow: /authorize (SDK) → consent page → POST /oauth/consent → Google → /oauth/google/callback
 * → our authorization code → /token (SDK). MCP clients only ever see tokens minted here; the
 * Google refresh token never leaves the server.
 */
export class HealthAuthProvider implements OAuthServerProvider {
  readonly mcpUrl: URL;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly google: GoogleOAuth,
    private readonly tokens: GoogleTokenManager,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.mcpUrl = new URL("/mcp", config.baseUrl);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.getClient(clientId),
      registerClient: async (client) => {
        for (const uri of client.redirect_uris) validateRedirectUri(uri);
        const full = client as OAuthClientInformationFull;
        await this.store.saveClient(full);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !this.isOurResource(params.resource)) {
      throw new InvalidTargetError(`Unknown resource ${params.resource.href}; expected ${this.mcpUrl.href}`);
    }
    const binding = this.browserBinding(res.req, res);
    const pending: PendingAuthorization = {
      id: randomToken(),
      kind: "oauth",
      browserBindingHash: sha256(binding),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      resource: params.resource?.href,
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    await this.store.savePending(pending);
    res
      .status(200)
      .type("html")
      .send(
        consentPage({
          requestId: pending.id,
          clientName: client.client_name ?? "Unnamed MCP client",
          redirectHost: describeRedirect(params.redirectUri),
          loopbackOnly: client.redirect_uris.every(isLoopback),
        }),
      );
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const record = await this.store.getCode(sha256(code));
    if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = await this.store.takeCode(sha256(code));
    if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (redirectUri && redirectUri !== record.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    if (resource && !this.isOurResource(resource)) throw new InvalidTargetError("Unknown resource");
    return this.issueTokens(record.userId, client.client_id, record.scopes, record.resource ?? this.mcpUrl.href);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const record = await this.store.getToken(hash);
    if (!record || record.kind !== "refresh" || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (resource && !this.isOurResource(resource)) throw new InvalidTargetError("Unknown resource");
    await this.store.deleteToken(hash); // rotate
    const user = await this.store.getUser(record.userId);
    if (!user?.googleRefreshTokenEnc) {
      throw new InvalidGrantError("Google authorization expired; sign in again");
    }
    const granted = user.googleScopes;
    const effective = scopes ? scopes.filter((s) => granted.includes(s)) : granted;
    return this.issueTokens(record.userId, client.client_id, effective, record.resource ?? this.mcpUrl.href);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.getToken(sha256(token));
    if (!record || record.kind !== "access") throw new InvalidTokenError("Invalid access token");
    if (record.expiresAt < Date.now()) throw new InvalidTokenError("Access token expired");
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource ? new URL(record.resource) : undefined,
      extra: { userId: record.userId },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = sha256(request.token);
    const record = await this.store.getToken(hash);
    if (record && record.clientId === client.client_id) await this.store.deleteToken(hash);
  }

  /** POST /oauth/consent — the user approved or denied an MCP client on the consent page. */
  async handleConsent(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, string>;
    const pending = await this.loadPending(req, res, body.request_id);
    if (!pending || pending.kind !== "oauth") return;

    if (body.action !== "approve") {
      await this.store.deletePending(pending.id);
      res.redirect(303, errorRedirect(pending, "access_denied", "The user denied the request"));
      return;
    }
    await this.redirectToGoogle(res, { ...pending, writeAccess: body.access === "write" });
  }

  /** GET /connect — start page for a personal access token (clients without OAuth support). */
  connectForm(_req: Request, res: Response): void {
    res.status(200).type("html").send(connectPage());
  }

  /** POST /connect — begin Google sign-in for a personal access token. */
  async handleConnect(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, string>;
    const binding = this.browserBinding(req, res);
    await this.redirectToGoogle(res, {
      id: randomToken(),
      kind: "personal",
      browserBindingHash: sha256(binding),
      writeAccess: body.access === "write",
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
  }

  /** GET /oauth/google/callback — Google redirects here after the user signs in. */
  async handleGoogleCallback(req: Request, res: Response): Promise<void> {
    const query = req.query as Record<string, string | undefined>;
    const pending = await this.loadPending(req, res, query.state);
    if (!pending) return;
    await this.store.deletePending(pending.id);

    const fail = (error: string, description: string) => {
      if (pending.kind === "oauth") res.redirect(302, errorRedirect(pending, error, description));
      else res.status(400).type("html").send(messagePage("Could not connect", description));
    };

    if (query.error || !query.code || !pending.googleCodeVerifier) {
      return fail("access_denied", `Google sign-in was not completed (${query.error ?? "no code"})`);
    }

    let result;
    try {
      result = await this.google.exchangeCode(query.code, pending.googleCodeVerifier);
    } catch (err) {
      console.error("Google code exchange failed", err instanceof Error ? err.message : err);
      return fail("server_error", "Could not complete Google sign-in");
    }

    if (!isEmailAllowed(this.config, result.email)) {
      return fail("access_denied", "This Google account is not allowed to use this server");
    }
    if (!result.scopes.some((s) => (READ_SCOPES as readonly string[]).includes(s))) {
      return fail("access_denied", "No Google Health read permissions were granted. Sign in again and allow access.");
    }
    if (await this.profileMissing(result.accessToken)) {
      return fail(
        "access_denied",
        "Your Google Health profile isn't ready. Open the Google Health app to complete setup, then connect again.",
      );
    }

    const existing = await this.store.getUser(result.sub);
    if (!result.refreshToken && !existing?.googleRefreshTokenEnc) {
      return fail("server_error", "Google did not issue a refresh token");
    }
    await this.store.upsertUser(result.sub, {
      email: result.email,
      googleScopes: result.scopes,
      ...(result.refreshToken ? { googleRefreshTokenEnc: encrypt(result.refreshToken, this.config.encryptionKey) } : {}),
    });
    this.tokens.seed(result.sub, result.accessToken, result.expiresIn);

    if (pending.kind === "personal") {
      const token = randomToken("ghm_");
      const expiresAt = Date.now() + this.config.personalTokenTtlSec * 1000;
      await this.store.saveToken(sha256(token), {
        kind: "access",
        userId: result.sub,
        clientId: PERSONAL_TOKEN_CLIENT_ID,
        scopes: result.scopes,
        resource: this.mcpUrl.href,
        expiresAt,
      });
      res
        .status(200)
        .type("html")
        .send(personalTokenPage({ token, mcpUrl: this.mcpUrl.href, expiresAt: new Date(expiresAt) }));
      return;
    }

    const code = randomToken();
    await this.store.saveCode(sha256(code), {
      userId: result.sub,
      clientId: pending.clientId!,
      codeChallenge: pending.codeChallenge!,
      redirectUri: pending.redirectUri!,
      scopes: result.scopes,
      resource: pending.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(pending.redirectUri!);
    target.searchParams.set("code", code);
    if (pending.state) target.searchParams.set("state", pending.state);
    res.redirect(302, target.href);
  }

  private async issueTokens(userId: string, clientId: string, scopes: string[], resource: string): Promise<OAuthTokens> {
    const now = Date.now();
    const accessToken = randomToken("gha_");
    const refreshToken = randomToken("ghr_");
    const base = { userId, clientId, scopes, resource };
    await Promise.all([
      this.store.saveToken(sha256(accessToken), {
        ...base,
        kind: "access",
        expiresAt: now + this.config.accessTokenTtlSec * 1000,
      }),
      this.store.saveToken(sha256(refreshToken), {
        ...base,
        kind: "refresh",
        expiresAt: now + this.config.refreshTokenTtlSec * 1000,
      }),
    ]);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSec,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private async redirectToGoogle(res: Response, pending: PendingAuthorization) {
    const verifier = randomToken();
    await this.store.savePending({ ...pending, googleCodeVerifier: verifier });
    res.redirect(
      303,
      this.google.buildAuthUrl({
        state: pending.id,
        codeChallenge: pkceChallenge(verifier),
        write: pending.writeAccess === true,
      }),
    );
  }

  private async loadPending(req: Request, res: Response, id: string | undefined) {
    const pending = id ? await this.store.getPending(id) : undefined;
    const binding = parseCookies(req.headers.cookie)[BINDING_COOKIE];
    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).type("html").send(messagePage("Request expired", "Start the connection again from your agent."));
      return undefined;
    }
    if (!binding || sha256(binding) !== pending.browserBindingHash) {
      res
        .status(400)
        .type("html")
        .send(messagePage("Browser mismatch", "Finish the sign-in in the same browser where you started it."));
      return undefined;
    }
    return pending;
  }

  /** Reuses or sets a random cookie that ties the consent and callback steps to one browser. */
  private browserBinding(req: Request, res: Response): string {
    const existing = parseCookies(req.headers.cookie)[BINDING_COOKIE];
    if (existing && /^[A-Za-z0-9_-]{32,}$/.test(existing)) return existing;
    const value = randomToken();
    const secure = this.config.baseUrl.protocol === "https:" ? "; Secure" : "";
    res.append("Set-Cookie", `${BINDING_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`);
    // Firebase Hosting drops Set-Cookie unless the response is marked private. The SDK's
    // authorize handler overwrites Cache-Control with plain "no-store", so set it again here.
    res.set("Cache-Control", "private, no-store");
    return value;
  }

  private isOurResource(resource: URL): boolean {
    const normalize = (u: URL) => u.href.replace(/\/$/, "");
    return normalize(resource) === normalize(this.mcpUrl) || normalize(resource) === normalize(this.config.baseUrl);
  }

  /** Google Health returns 412 until the user finishes onboarding in the app. */
  private async profileMissing(accessToken: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.config.healthApiBase}/v4/users/me/identity`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      return res.status === 412;
    } catch {
      return false;
    }
  }
}

function validateRedirectUri(uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new InvalidClientMetadataError(`Invalid redirect_uri: ${uri}`);
  }
  if (["javascript:", "data:", "file:", "vbscript:"].includes(url.protocol)) {
    throw new InvalidClientMetadataError(`Disallowed redirect_uri scheme: ${url.protocol}`);
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new InvalidClientMetadataError("http redirect URIs are only allowed for loopback addresses");
  }
  if (url.hash) throw new InvalidClientMetadataError("redirect_uri must not contain a fragment");
}

function isLoopback(uri: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
}

function describeRedirect(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : `${url.protocol}//${url.host}`;
  } catch {
    return uri;
  }
}

function errorRedirect(pending: PendingAuthorization, error: string, description: string): string {
  const url = new URL(pending.redirectUri!);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (pending.state) url.searchParams.set("state", pending.state);
  return url.href;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
