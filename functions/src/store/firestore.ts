import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Firestore } from "firebase-admin/firestore";
import type { AuthCodeRecord, PendingAuthorization, Store, TokenRecord, UserRecord } from "./types.js";

const COLLECTIONS = {
  clients: "oauthClients",
  pending: "authRequests",
  codes: "authCodes",
  tokens: "tokens",
  users: "users",
} as const;

/**
 * Firestore-backed store. Short-lived documents carry a `ttl` timestamp so a Firestore TTL policy
 * can garbage-collect them; reads also check `expiresAt`, so correctness doesn't depend on TTL.
 */
export class FirestoreStore implements Store {
  constructor(private readonly db: Firestore) {}

  private col(name: keyof typeof COLLECTIONS) {
    return this.db.collection(COLLECTIONS[name]);
  }

  async getClient(clientId: string) {
    const snap = await this.col("clients").doc(clientId).get();
    return snap.exists ? (snap.data() as OAuthClientInformationFull) : undefined;
  }
  async saveClient(client: OAuthClientInformationFull) {
    await this.col("clients").doc(client.client_id).set({ ...client, createdAt: new Date() });
  }

  async savePending(p: PendingAuthorization) {
    await this.col("pending").doc(p.id).set({ ...p, ttl: new Date(p.expiresAt) });
  }
  async getPending(id: string) {
    const snap = await this.col("pending").doc(id).get();
    return snap.exists ? strip<PendingAuthorization>(snap.data()) : undefined;
  }
  async deletePending(id: string) {
    await this.col("pending").doc(id).delete();
  }

  async saveCode(hash: string, record: AuthCodeRecord) {
    await this.col("codes").doc(hash).set({ ...record, ttl: new Date(record.expiresAt) });
  }
  async getCode(hash: string) {
    const snap = await this.col("codes").doc(hash).get();
    return snap.exists ? strip<AuthCodeRecord>(snap.data()) : undefined;
  }
  async takeCode(hash: string) {
    const ref = this.col("codes").doc(hash);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return undefined;
      tx.delete(ref);
      return strip<AuthCodeRecord>(snap.data());
    });
  }

  async saveToken(hash: string, record: TokenRecord) {
    await this.col("tokens").doc(hash).set({ ...record, ttl: new Date(record.expiresAt) });
  }
  async getToken(hash: string) {
    const snap = await this.col("tokens").doc(hash).get();
    return snap.exists ? strip<TokenRecord>(snap.data()) : undefined;
  }
  async deleteToken(hash: string) {
    await this.col("tokens").doc(hash).delete();
  }
  async deleteTokensForUser(userId: string) {
    const snap = await this.col("tokens").where("userId", "==", userId).get();
    const writer = this.db.bulkWriter();
    snap.docs.forEach((doc) => void writer.delete(doc.ref));
    await writer.close();
  }

  async getUser(sub: string) {
    const snap = await this.col("users").doc(sub).get();
    return snap.exists ? (snap.data() as UserRecord) : undefined;
  }
  async upsertUser(sub: string, patch: Partial<Omit<UserRecord, "sub" | "createdAt">>) {
    const ref = this.col("users").doc(sub);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const existing = snap.exists ? (snap.data() as UserRecord) : undefined;
      const next: UserRecord = { sub, googleScopes: [], createdAt: now, ...existing, ...patch, updatedAt: now };
      tx.set(ref, next);
      return next;
    });
  }
}

function strip<T>(data: FirebaseFirestore.DocumentData | undefined): T {
  const { ttl: _ttl, ...rest } = data ?? {};
  return rest as T;
}
