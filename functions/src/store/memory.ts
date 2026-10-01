import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthCodeRecord, PendingAuthorization, Store, TokenRecord, UserRecord } from "./types.js";

/** In-process store for local development and tests. Data is lost on restart. */
export class MemoryStore implements Store {
  private clients = new Map<string, OAuthClientInformationFull>();
  private pending = new Map<string, PendingAuthorization>();
  private codes = new Map<string, AuthCodeRecord>();
  private tokens = new Map<string, TokenRecord>();
  private users = new Map<string, UserRecord>();

  async getClient(clientId: string) {
    return this.clients.get(clientId);
  }
  async saveClient(client: OAuthClientInformationFull) {
    this.clients.set(client.client_id, client);
  }

  async savePending(p: PendingAuthorization) {
    this.pending.set(p.id, { ...p });
  }
  async getPending(id: string) {
    const p = this.pending.get(id);
    return p ? { ...p } : undefined;
  }
  async deletePending(id: string) {
    this.pending.delete(id);
  }

  async saveCode(hash: string, record: AuthCodeRecord) {
    this.codes.set(hash, record);
  }
  async getCode(hash: string) {
    return this.codes.get(hash);
  }
  async takeCode(hash: string) {
    const record = this.codes.get(hash);
    this.codes.delete(hash);
    return record;
  }

  async saveToken(hash: string, record: TokenRecord) {
    this.tokens.set(hash, record);
  }
  async getToken(hash: string) {
    return this.tokens.get(hash);
  }
  async deleteToken(hash: string) {
    this.tokens.delete(hash);
  }
  async deleteTokensForUser(userId: string) {
    for (const [hash, record] of this.tokens) {
      if (record.userId === userId) this.tokens.delete(hash);
    }
  }

  async getUser(sub: string) {
    const user = this.users.get(sub);
    return user ? structuredClone(user) : undefined;
  }
  async upsertUser(sub: string, patch: Partial<Omit<UserRecord, "sub" | "createdAt">>) {
    const now = Date.now();
    const existing = this.users.get(sub);
    const next: UserRecord = {
      sub,
      googleScopes: [],
      createdAt: now,
      ...existing,
      ...patch,
      updatedAt: now,
    };
    this.users.set(sub, next);
    return structuredClone(next);
  }
}
