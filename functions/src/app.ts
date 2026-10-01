import express, { type NextFunction, type Request, type Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import { GoogleTokenManager, type GoogleOAuth } from "./auth/google.js";
import { landingPage } from "./auth/pages.js";
import { HealthAuthProvider } from "./auth/provider.js";
import { HealthClient } from "./health/client.js";
import { createToolContext } from "./mcp/context.js";
import { createMcpServer } from "./mcp/server.js";
import type { Store } from "./store/types.js";

export interface AppDeps {
  config: AppConfig;
  store: Store;
  google: GoogleOAuth;
  fetchImpl?: typeof fetch;
}

export function createApp({ config, store, google, fetchImpl }: AppDeps) {
  const tokens = new GoogleTokenManager(store, google, config.encryptionKey);
  const provider = new HealthAuthProvider(config, store, google, tokens, fetchImpl);
  const mcpUrl = provider.mcpUrl;

  const app = express();
  // Trust only the nearest proxy (Google's front end), whose X-Forwarded-For entry can't be spoofed.
  // Behind Firebase Hosting, rate limits therefore apply per Hosting edge rather than per end user.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    // Firebase Hosting's CDN must never cache these responses. "private" is also what makes
    // Hosting pass Set-Cookie (the __session browser binding) through to the browser.
    res.set("Cache-Control", "private, no-store");
    next();
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.baseUrl,
      resourceServerUrl: mcpUrl,
      resourceName: "Google Health MCP",
      serviceDocumentationUrl: config.baseUrl,
      // The SDK limits by client IP. Behind Hosting, and with every Claude surface calling from
      // Anthropic's egress range, one IP stands for many users, so the defaults (register 20/h,
      // token 50/15min) would act as instance-wide caps. Raise them to fit ~100 users.
      authorizationOptions: { rateLimit: { max: 300 } },
      tokenOptions: { rateLimit: { max: 600 } },
      clientRegistrationOptions: { rateLimit: { max: 100 } },
      revocationOptions: { rateLimit: { max: 200 } },
    }),
  );

  const form = express.urlencoded({ extended: false });
  const wrap = (fn: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

  app.post("/oauth/consent", form, wrap((req, res) => provider.handleConsent(req, res)));
  app.get("/oauth/google/callback", wrap((req, res) => provider.handleGoogleCallback(req, res)));
  app.get("/connect", (req, res) => provider.connectForm(req, res));
  app.post("/connect", form, wrap((req, res) => provider.handleConnect(req, res)));
  app.get("/", (_req, res) => {
    res.type("html").send(landingPage(mcpUrl.href));
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  const cors = (req: Request, res: Response, next: NextFunction) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.set("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  };
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  app.options("/mcp", cors);
  app.post(
    "/mcp",
    cors,
    bearer,
    express.json({ limit: "1mb" }),
    wrap(async (req, res) => {
      const auth = req.auth!;
      const userId = String(auth.extra?.userId);
      const health = new HealthClient({
        baseUrl: config.healthApiBase,
        getAccessToken: () => tokens.getAccessToken(userId),
        onUnauthorized: () => tokens.invalidate(userId),
        fetchImpl,
      });
      const ctx = createToolContext({ userId, scopes: new Set(auth.scopes), health, store, tokens });
      // Stateless: a fresh server and transport per request, so any instance can serve any request.
      const server = createMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }),
  );
  // No server-initiated streams or sessions in stateless mode.
  app.get("/mcp", cors, (_req, res) => {
    res.set("Allow", "POST").status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });
  app.delete("/mcp", cors, (_req, res) => {
    res.set("Allow", "POST").status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error", err instanceof Error ? err.stack : err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });

  return app;
}
