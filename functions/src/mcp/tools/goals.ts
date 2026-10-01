import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { round, simplifyRollup, rollupDate } from "../../health/summarize.js";
import { addDays, resolveRange, todayIn } from "../../health/time.js";
import { runTool, type ToolContext } from "../context.js";
import { averages, energyBalance, evaluateTargets, GOAL_FIELDS, weightTrend, type Goals } from "../goals.js";
import { buildDailySummaries } from "../summaries.js";

export function registerGoalTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "get_goals",
    {
      title: "Get coaching goals",
      description:
        "The user's coaching goals: body targets (weight, body fat, date), daily calorie/macro/water targets, step, " +
        "Active Zone Minutes, workout and sleep targets, and a free-text coaching plan.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      runTool(async () => {
        const user = await ctx.store.getUser(ctx.userId);
        return { goals: user?.goals ?? {}, storedBy: "this MCP server (Google Health has no goals API)" };
      }),
  );

  const setShape = Object.fromEntries(
    Object.entries(GOAL_FIELDS).map(([k, schema]) => [k, schema.nullable().optional()]),
  ) as { [K in keyof typeof GOAL_FIELDS]: z.ZodOptional<z.ZodNullable<(typeof GOAL_FIELDS)[K]>> };

  server.registerTool(
    "set_goals",
    {
      title: "Set coaching goals",
      description:
        "Creates or updates coaching goals. Only the fields you pass change; pass null to clear a field. Confirm " +
        "targets with the user before saving. When setting a new weight target, also set startWeightKg and startDate.",
      inputSchema: setShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      runTool(async () => {
        const user = await ctx.store.getUser(ctx.userId);
        const goals: Record<string, unknown> = { ...(user?.goals ?? {}) };
        for (const [key, value] of Object.entries(args)) {
          if (value === null) delete goals[key];
          else if (value !== undefined) goals[key] = value;
        }
        goals.updatedAt = new Date().toISOString();
        const saved = await ctx.store.upsertUser(ctx.userId, { goals: goals as Goals });
        return { goals: saved.goals };
      }),
  );

  server.registerTool(
    "get_goal_progress",
    {
      title: "Goal progress",
      description:
        "Evaluates the user's goals against their data: per-target averages and days met over the period, a smoothed " +
        "weight trend with weekly rate and projected date to reach the target weight, estimated energy balance " +
        "(intake vs burn), and today's progress so far. Works without goals too (returns trends and averages).",
      inputSchema: {
        days: z.number().int().min(3).max(90).optional().describe("Period length in full days (default 7)"),
        endDate: z.string().optional().describe("Last day of the period (YYYY-MM-DD); default yesterday"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ days = 7, endDate }) =>
      runTool(async () => {
        const tz = await ctx.timeZone();
        const today = todayIn(tz);
        const end = endDate ?? addDays(today, -1);
        const range = resolveRange({ startDate: addDays(end, -(days - 1)), endDate: end }, tz, days, 90);
        const todayRange = resolveRange({ startDate: today, endDate: today }, tz, 1, 1);
        const weightWindow = resolveRange({ startDate: addDays(today, -41), endDate: today }, tz, 42, 90);
        const canReadBody = ctx.scopes.has("health_metrics_and_measurements.readonly");

        const [user, period, todaySummary, weights] = await Promise.all([
          ctx.store.getUser(ctx.userId),
          buildDailySummaries(ctx, range),
          buildDailySummaries(ctx, todayRange, ["activity", "energy", "nutrition"]),
          canReadBody
            ? ctx.health.dailyRollUp("weight", weightWindow.start, weightWindow.endExclusive, "all-sources").catch(() => [])
            : Promise.resolve([]),
        ]);
        const goals = user?.goals ?? {};
        const series = weights
          .map((p) => ({ date: rollupDate(p)!, kg: simplifyRollup("weight", p).kg as number }))
          .filter((p) => p.date && typeof p.kg === "number");

        const t = todaySummary.days[0] ?? { date: today };
        const remaining = (target: number | undefined, actual: number | undefined) =>
          target !== undefined ? round(target - (actual ?? 0), 0) : undefined;

        return {
          timeZone: tz,
          goalsSet: Object.keys(goals).some((k) => k !== "updatedAt"),
          goals,
          period: { start: range.start, end: range.end, days: range.days },
          targets: evaluateTargets(goals, period.days),
          averages: averages(period.days),
          energyBalance: energyBalance(period.days),
          weightTrend: canReadBody ? weightTrend(series, goals, today) : "permission not granted",
          today: {
            ...t,
            remainingKcal: remaining(goals.dailyCaloriesKcal, t.intakeKcal),
            remainingProteinG: remaining(goals.dailyProteinG, t.proteinG),
            remainingSteps: remaining(goals.dailySteps, t.steps),
            note: "Today is in progress; device data appears after the next sync.",
          },
          ...(period.unavailable ? { unavailable: period.unavailable } : {}),
        };
      }),
  );
}
