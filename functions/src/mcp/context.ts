import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GoogleAuthExpiredError, type GoogleTokenManager } from "../auth/google.js";
import { HealthApiError, type HealthClient, type Json } from "../health/client.js";
import { isValidTimeZone } from "../health/time.js";
import type { Store } from "../store/types.js";

export interface ToolContext {
  userId: string;
  /** Google Health scopes granted by the user, short form ("sleep.readonly"). */
  scopes: Set<string>;
  health: HealthClient;
  store: Store;
  tokens: GoogleTokenManager;
  settings(): Promise<Json | undefined>;
  timeZone(): Promise<string>;
}

export function createToolContext(opts: Omit<ToolContext, "settings" | "timeZone">): ToolContext {
  let settings: Promise<Json | undefined> | undefined;
  const ctx: ToolContext = {
    ...opts,
    settings() {
      if (!opts.scopes.has("settings.readonly")) return Promise.resolve(undefined);
      settings ??= opts.health.getSettings().catch(() => undefined);
      return settings;
    },
    async timeZone() {
      const tz = (await ctx.settings())?.timeZone;
      return typeof tz === "string" && isValidTimeZone(tz) ? tz : "UTC";
    },
  };
  return ctx;
}

export class UserInputError extends Error {}

export function requireScope(ctx: ToolContext, scope: string, what: string) {
  if (!ctx.scopes.has(scope)) {
    const write = scope.endsWith(".writeonly");
    throw new UserInputError(
      `The user hasn't granted ${write ? "write" : "read"} access to ${what}. ` +
        (write
          ? "To enable it, reconnect this MCP server and choose 'Read and write' on the consent page."
          : "To enable it, reconnect this MCP server and allow that category on the Google consent screen."),
    );
  }
}

export function describeError(err: unknown): string {
  if (err instanceof GoogleAuthExpiredError || err instanceof UserInputError) return err.message;
  if (err instanceof HealthApiError) {
    switch (err.status) {
      case 400:
        return `Google Health rejected the request: ${err.message}`;
      case 401:
        return "Google Health rejected the stored credentials. Reconnect this MCP server to sign in again.";
      case 403:
        return (
          `Google Health denied access (${err.message}). The user may not have granted this data category; ` +
          "reconnect the server and allow it on the Google consent screen."
        );
      case 404:
        return `Not found: ${err.message}`;
      case 412:
        return "The user's Google Health profile isn't set up yet. Ask them to open the Google Health app and finish onboarding.";
      case 429:
        return "Google Health rate limit reached (300 requests/minute per user). Wait a minute, then retry with a smaller range.";
      default:
        return `Google Health API error ${err.status}: ${err.message}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Claude rejects tool results above ~150,000 characters (claude.ai, Desktop, mobile), and Claude Code
 * above 25,000 tokens by default. Stay under both and ask for a narrower query instead.
 */
const MAX_RESULT_CHARS = 90_000;

export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const text = JSON.stringify(await fn());
    if (text.length > MAX_RESULT_CHARS) {
      throw new UserInputError(
        `The result is too large (${text.length} characters, limit ${MAX_RESULT_CHARS}). ` +
          "Use a shorter date range, a lower limit, or an aggregate tool such as get_metric_series.",
      );
    }
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const expected = err instanceof UserInputError || err instanceof RangeError || (err instanceof HealthApiError && err.status < 500);
    if (!expected) {
      console.error("tool error", err instanceof Error ? err.stack : err);
    }
    return { content: [{ type: "text", text: describeError(err) }], isError: true };
  }
}

/** Runs async jobs with bounded parallelism (the API allows ~5 requests/second per user). */
export async function withConcurrency<T>(limit: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}
