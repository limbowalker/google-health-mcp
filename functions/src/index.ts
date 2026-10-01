import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/https";
import { defineInt, defineSecret, defineString } from "firebase-functions/params";
import type { Express } from "express";
import { createApp } from "./app.js";
import { GoogleOAuthClient } from "./auth/google.js";
import { buildConfig } from "./config.js";
import { FirestoreStore } from "./store/firestore.js";

const GOOGLE_CLIENT_ID = defineString("GOOGLE_CLIENT_ID", {
  description: "OAuth 2.0 Web client ID from Google Cloud Console > Credentials",
});
const PUBLIC_BASE_URL = defineString("PUBLIC_BASE_URL", {
  description: "Public origin of this deployment, or 'auto' for https://<project-id>.web.app",
  default: "auto",
});
const ALLOWED_EMAILS = defineString("ALLOWED_EMAILS", {
  description: "Comma-separated allowlist of Google accounts or @domains, or '*' to allow any account",
  default: "*",
});
const MIN_INSTANCES = defineInt("MIN_INSTANCES", {
  description: "Instances kept warm. 1 avoids cold starts (Claude allows 10 s for OAuth endpoints) but is billed while idle",
  default: 0,
});
const GOOGLE_CLIENT_SECRET = defineSecret("GOOGLE_CLIENT_SECRET");
const TOKEN_ENCRYPTION_KEY = defineSecret("TOKEN_ENCRYPTION_KEY");

initializeApp();
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

let app: Express | undefined;

function projectId(): string | undefined {
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  try {
    return JSON.parse(process.env.FIREBASE_CONFIG ?? "{}").projectId;
  } catch {
    return undefined;
  }
}

function getApp(): Express {
  if (!app) {
    const config = buildConfig({
      baseUrl: PUBLIC_BASE_URL.value() === "auto" ? `https://${projectId()}.web.app` : PUBLIC_BASE_URL.value(),
      googleClientId: GOOGLE_CLIENT_ID.value(),
      googleClientSecret: GOOGLE_CLIENT_SECRET.value(),
      encryptionKey: TOKEN_ENCRYPTION_KEY.value(),
      allowedEmails: ALLOWED_EMAILS.value(),
    });
    app = createApp({ config, store: new FirestoreStore(db), google: new GoogleOAuthClient(config) });
  }
  return app;
}

export const api = onRequest(
  {
    region: "us-central1",
    secrets: [GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY],
    invoker: "public",
    memory: "512MiB",
    timeoutSeconds: 60,
    concurrency: 80,
    minInstances: MIN_INSTANCES,
    maxInstances: 10,
  },
  (req, res) => {
    getApp()(req, res);
  },
);
