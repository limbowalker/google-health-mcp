import type { Json } from "../health/client.js";
import { num, rollupDate, round, simplifyRollup, summarizeExercise, summarizeSleep } from "../health/summarize.js";
import { eachDate, fromCivil, type DateRange } from "../health/time.js";
import { describeError, withConcurrency, type ToolContext } from "./context.js";
import type { DaySummary } from "./goals.js";

export const SUMMARY_GROUPS = ["activity", "energy", "heart", "sleep", "body", "nutrition", "workouts"] as const;
export type SummaryGroup = (typeof SUMMARY_GROUPS)[number];

const GROUP_SCOPE: Record<SummaryGroup, string> = {
  activity: "activity_and_fitness.readonly",
  energy: "activity_and_fitness.readonly",
  workouts: "activity_and_fitness.readonly",
  heart: "health_metrics_and_measurements.readonly",
  body: "health_metrics_and_measurements.readonly",
  sleep: "sleep.readonly",
  nutrition: "nutrition.readonly",
};

export interface DailySummaryResult {
  days: DaySummary[];
  unavailable?: Record<string, string>;
}

/**
 * Builds one row per civil day from rollups and reconciled daily data. Each group is fetched
 * independently, so a missing permission or failing type only blanks its own columns.
 */
export async function buildDailySummaries(
  ctx: ToolContext,
  range: DateRange,
  groups: readonly SummaryGroup[] = SUMMARY_GROUPS,
): Promise<DailySummaryResult> {
  const rows = new Map<string, DaySummary>(eachDate(range.start, range.endExclusive).map((d) => [d, { date: d }]));
  const unavailable: Record<string, string> = {};
  const set = (date: string | undefined, patch: Partial<DaySummary>) => {
    const row = date ? rows.get(date) : undefined;
    if (!row) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (row as any)[k] = v;
  };

  type Job = { type: string; run: () => Promise<void> };
  const rollup = (type: string, apply: (date: string, value: Json) => void): Job => ({
    type,
    run: async () => {
      const points = await ctx.health.dailyRollUp(type, range.start, range.endExclusive, "all-sources");
      for (const p of points) {
        const date = rollupDate(p);
        if (date) apply(date, simplifyRollup(type, p));
      }
    },
  });
  const reconciled = (type: string, filter: string, max: number, apply: (p: Json) => void): Job => ({
    type,
    run: async () => {
      const { dataPoints } = await ctx.health.collect("reconcile", type, { filter, family: "all-sources" }, max);
      dataPoints.forEach(apply);
    },
  });

  const jobs: Record<SummaryGroup, Job[]> = {
    activity: [
      rollup("steps", (d, v) => set(d, { steps: v.steps })),
      rollup("distance", (d, v) => set(d, { distanceKm: v.km })),
      rollup("active-zone-minutes", (d, v) => set(d, { activeZoneMinutes: v.total })),
    ],
    energy: [
      rollup("total-calories", (d, v) => set(d, { totalKcal: v.kcal })),
      rollup("active-energy-burned", (d, v) => set(d, { activeKcal: v.kcal })),
    ],
    heart: [
      reconciled(
        "daily-resting-heart-rate",
        `daily_resting_heart_rate.date >= "${range.start}" AND daily_resting_heart_rate.date < "${range.endExclusive}"`,
        400,
        (p) => set(fromCivil(p.dailyRestingHeartRate?.date), { restingHeartRate: num(p.dailyRestingHeartRate?.beatsPerMinute) }),
      ),
      reconciled(
        "daily-heart-rate-variability",
        `daily_heart_rate_variability.date >= "${range.start}" AND daily_heart_rate_variability.date < "${range.endExclusive}"`,
        400,
        (p) =>
          set(fromCivil(p.dailyHeartRateVariability?.date), {
            hrvMs: round(num(p.dailyHeartRateVariability?.averageHeartRateVariabilityMilliseconds), 1),
          }),
      ),
    ],
    sleep: [
      reconciled(
        "sleep",
        `sleep.interval.civil_end_time >= "${range.start}" AND sleep.interval.civil_end_time < "${range.endExclusive}"`,
        range.days * 3,
        (p) => {
          const s = summarizeSleep(p);
          const row = s.date ? rows.get(s.date) : undefined;
          if (!row || s.minutesAsleep === undefined) return;
          row.sleepMinutes = (row.sleepMinutes ?? 0) + s.minutesAsleep;
          if (s.mainSleep || row.sleepEfficiencyPct === undefined) row.sleepEfficiencyPct = s.efficiencyPct;
        },
      ),
    ],
    body: [
      rollup("weight", (d, v) => set(d, { weightKg: v.kg })),
      rollup("body-fat", (d, v) => set(d, { bodyFatPct: v.pct })),
    ],
    nutrition: [
      rollup("nutrition-log", (d, v) =>
        set(d, { intakeKcal: v.kcal, proteinG: v.proteinG, carbsG: v.carbsG, fatG: v.fatG, fiberG: v.fiberG }),
      ),
      rollup("hydration-log", (d, v) => set(d, { waterMl: v.ml })),
    ],
    workouts: [
      reconciled(
        "exercise",
        `exercise.interval.civil_start_time >= "${range.start}" AND exercise.interval.civil_start_time < "${range.endExclusive}"`,
        range.days * 4,
        (p) => {
          const w = summarizeExercise(p);
          const row = w.start ? rows.get(String(w.start).slice(0, 10)) : undefined;
          if (!row) return;
          row.workouts = (row.workouts ?? 0) + 1;
          row.workoutMinutes = (row.workoutMinutes ?? 0) + (w.durationMin ?? 0);
        },
      ),
    ],
  };

  const tasks: (() => Promise<void>)[] = [];
  for (const group of groups) {
    if (!ctx.scopes.has(GROUP_SCOPE[group])) {
      unavailable[group] = `permission ${GROUP_SCOPE[group]} not granted`;
      continue;
    }
    for (const job of jobs[group]) {
      tasks.push(() =>
        job.run().catch((err) => {
          unavailable[job.type] = describeError(err);
        }),
      );
    }
  }
  await withConcurrency(4, tasks);

  return { days: [...rows.values()], ...(Object.keys(unavailable).length ? { unavailable } : {}) };
}
