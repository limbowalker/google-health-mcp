/**
 * Local development server: `npm run dev`. Uses an in-memory store unless FIRESTORE_EMULATOR_HOST
 * or USE_FIRESTORE=1 is set. Configure via functions/.env.local (see README).
 */
import { randomBytes } from "node:crypto";
import { createApp } from "./app.js";
import { GoogleOAuthClient } from "./auth/google.js";
import { buildConfig } from "./config.js";
import { MemoryStore } from "./store/memory.js";
import type { Store } from "./store/types.js";

const port = Number(process.env.PORT ?? 8080);
const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY ?? randomBytes(32).toString("base64");
if (!process.env.TOKEN_ENCRYPTION_KEY) {
  console.warn("TOKEN_ENCRYPTION_KEY not set; using an ephemeral key (stored tokens won't survive a restart).");
}

const config = buildConfig({
  baseUrl:
    process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL !== "auto"
      ? process.env.PUBLIC_BASE_URL
      : `http://localhost:${port}`,
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  encryptionKey,
  allowedEmails: process.env.ALLOWED_EMAILS,
  healthApiBase: process.env.HEALTH_API_BASE,
});

async function createStore(): Promise<Store> {
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.USE_FIRESTORE === "1") {
    const { initializeApp } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    const { FirestoreStore } = await import("./store/firestore.js");
    initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "demo-ghealth-mcp" });
    const db = getFirestore();
    db.settings({ ignoreUndefinedProperties: true });
    return new FirestoreStore(db);
  }
  return new MemoryStore();
}

const store = await createStore();
createApp({ config, store, google: new GoogleOAuthClient(config) }).listen(port, () => {
  console.log(`Google Health MCP listening on ${config.baseUrl.href}  (MCP endpoint: ${new URL("/mcp", config.baseUrl).href})`);
});
