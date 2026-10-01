import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Goals } from "../mcp/goals.js";

/** An authorization in progress: created at /authorize (or /connect), consumed at the Google callback. */
export interface PendingAuthorization {
  id: string;
  kind: "oauth" | "personal";
  /** SHA-256 of the browser-binding cookie that must accompany consent and callback. */
  browserBindingHash: string;
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  state?: string;
  resource?: string;
  writeAccess?: boolean;
  googleCodeVerifier?: string;
  expiresAt: number;
}

export interface AuthCodeRecord {
  userId: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  kind: "access" | "refresh";
  userId: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface UserRecord {
  sub: string;
  email?: string;
  googleRefreshTokenEnc?: string | null;
  /** Google Health scopes the user granted, short form, e.g. "sleep.readonly". */
  googleScopes: string[];
  goals?: Goals;
  createdAt: number;
  updatedAt: number;
}

export interface Store {
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  saveClient(client: OAuthClientInformationFull): Promise<void>;

  savePending(pending: PendingAuthorization): Promise<void>;
  getPending(id: string): Promise<PendingAuthorization | undefined>;
  deletePending(id: string): Promise<void>;

  saveCode(codeHash: string, record: AuthCodeRecord): Promise<void>;
  getCode(codeHash: string): Promise<AuthCodeRecord | undefined>;
  /** Atomically reads and deletes the code, so it can be redeemed only once. */
  takeCode(codeHash: string): Promise<AuthCodeRecord | undefined>;

  saveToken(tokenHash: string, record: TokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<TokenRecord | undefined>;
  deleteToken(tokenHash: string): Promise<void>;
  deleteTokensForUser(userId: string): Promise<void>;

  getUser(sub: string): Promise<UserRecord | undefined>;
  upsertUser(sub: string, patch: Partial<Omit<UserRecord, "sub" | "createdAt">>): Promise<UserRecord>;
}
