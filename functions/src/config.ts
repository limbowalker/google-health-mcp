export interface AppConfig {
  /** Public origin of the deployment, e.g. https://my-project.web.app */
  baseUrl: URL;
  googleClientId: string;
  googleClientSecret: string;
  /** 32-byte key used to encrypt Google refresh tokens at rest. */
  encryptionKey: Buffer;
  /** Lowercase emails, or "@domain" entries. Empty (or "*" in the input) means any Google account may connect. */
  allowedEmails: string[];
  healthApiBase: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  personalTokenTtlSec: number;
}

export interface ConfigInput {
  baseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  encryptionKey: string;
  allowedEmails?: string;
  healthApiBase?: string;
}

export function buildConfig(input: ConfigInput): AppConfig {
  const missing = Object.entries({
    PUBLIC_BASE_URL: input.baseUrl,
    GOOGLE_CLIENT_ID: input.googleClientId,
    GOOGLE_CLIENT_SECRET: input.googleClientSecret,
    TOKEN_ENCRYPTION_KEY: input.encryptionKey,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);

  const baseUrl = new URL(input.baseUrl);
  baseUrl.pathname = "/";
  baseUrl.search = "";
  baseUrl.hash = "";

  return {
    baseUrl,
    googleClientId: input.googleClientId,
    googleClientSecret: input.googleClientSecret,
    encryptionKey: parseKey(input.encryptionKey),
    allowedEmails: (input.allowedEmails ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && s !== "*"),
    healthApiBase: (input.healthApiBase || "https://health.googleapis.com").replace(/\/$/, ""),
    accessTokenTtlSec: 60 * 60,
    refreshTokenTtlSec: 30 * 24 * 60 * 60,
    personalTokenTtlSec: 90 * 24 * 60 * 60,
  };
}

function parseKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, encoded as base64 or 64 hex characters");
  }
  return key;
}

export function isEmailAllowed(config: AppConfig, email: string | undefined): boolean {
  if (config.allowedEmails.length === 0) return true;
  if (!email) return false;
  const normalized = email.toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf("@"));
  return config.allowedEmails.some((entry) => entry === normalized || entry === domain);
}
