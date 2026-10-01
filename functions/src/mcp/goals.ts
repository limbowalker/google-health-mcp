import { z } from "zod";
import { round } from "../health/summarize.js";
import { addDays, daysBetween } from "../health/time.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/**
 * Coaching goals. The Google Health API has no goals resource, so these are stored by this
 * server (Firestore) and evaluated against live Google Health data.
 */
export const GOAL_FIELDS = {
  targetWeightKg: z.number().min(20).max(400).describe("Goal body weight in kg"),
  targetBodyFatPct: z.number().min(2).max(70).describe("Goal body fat percentage"),
  targetDate: date.describe("Date by which to reach the body goals"),
  startWeightKg: z.number().min(20).max(400).describe("Weight when the current plan started, for progress %"),
  startDate: date.describe("Date the current plan started"),
  dailyCaloriesKcal: z.number().int().min(800).max(10000).describe("Daily calorie intake target"),
  dailyProteinG: z.number().min(0).max(1000).describe("Daily protein target in grams"),
  dailyCarbsG: z.number().min(0).max(2000).describe("Daily carbohydrate target in grams"),
  dailyFatG: z.number().min(0).max(1000).describe("Daily fat target in grams"),
  dailyFiberG: z.number().min(0).max(300).describe("Daily fiber target in grams"),
  dailyWaterMl: z.number().min(0).max(10000).describe("Daily water intake target in ml"),
  dailySteps: z.number().int().min(0).max(100000).describe("Daily step target"),
  weeklyActiveZoneMinutes: z.number().int().min(0).max(5000).describe("Weekly Active Zone Minutes target"),
  weeklyWorkouts: z.number().int().min(0).max(50).describe("Workouts per week target"),
  dailySleepMinutes: z.number().int().min(0).max(1000).describe("Nightly sleep target in minutes"),
  coachingPlan: z
    .string()
    .max(4000)
    .describe("Free-text plan and context the coach should remember (training split, preferences, constraints)"),
};

type GoalFieldTypes = { [K in keyof typeof GOAL_FIELDS]: z.infer<(typeof GOAL_FIELDS)[K]> };
export type Goals = Partial<GoalFieldTypes> & { updatedAt?: string };

/** One day of the daily summary table; see get_daily_summaries. */
export interface DaySummary {
  date: string;
  steps?: number;
  distanceKm?: number;
  totalKcal?: number;
  activeKcal?: number;
  activeZoneMinutes?: number;
  restingHeartRate?: number;
  hrvMs?: number;
  sleepMinutes?: number;
  sleepEfficiencyPct?: number;
  weightKg?: number;
  bodyFatPct?: number;
  intakeKcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fiberG?: number;
  waterMl?: number;
  workouts?: number;
  workoutMinutes?: number;
}

type NumericKey = Exclude<keyof DaySummary, "date">;

function values(days: DaySummary[], key: NumericKey): number[] {
  return days.map((d) => d[key]).filter((v): v is number => typeof v === "number");
}

export function mean(xs: number[]): number | undefined {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

export function averages(days: DaySummary[]): Partial<Record<NumericKey, number>> {
  const keys = new Set(days.flatMap((d) => Object.keys(d).filter((k) => k !== "date"))) as Set<NumericKey>;
  const out: Partial<Record<NumericKey, number>> = {};
  for (const key of keys) {
    const avg = mean(values(days, key));
    if (avg !== undefined) out[key] = round(avg, key.endsWith("Kg") || key.endsWith("Km") ? 2 : 1);
  }
  return out;
}

export interface WeightTrend {
  latestKg?: number;
  latestDate?: string;
  trendKg?: number;
  weeklyChangeKg?: number;
  measurements: number;
  targetKg?: number;
  remainingKg?: number;
  projectedTargetDate?: string;
  requiredWeeklyChangeKg?: number;
  progressPct?: number;
  note?: string;
}

/**
 * Smoothed weight trend: an exponentially weighted moving average (alpha 0.1 per day, as in
 * "The Hacker's Diet") to damp water-weight noise, plus a least-squares slope for the weekly rate.
 */
export function weightTrend(series: { date: string; kg: number }[], goals: Goals, today: string): WeightTrend {
  const points = [...series].sort((a, b) => a.date.localeCompare(b.date));
  if (points.length === 0) return { measurements: 0, note: "No weight measurements in the window" };

  let trend = points[0].kg;
  const byDate = new Map(points.map((p) => [p.date, p.kg]));
  for (let d = points[0].date; d <= points[points.length - 1].date; d = addDays(d, 1)) {
    const kg = byDate.get(d);
    if (kg !== undefined) trend += 0.1 * (kg - trend);
  }

  const latest = points[points.length - 1];
  const result: WeightTrend = {
    latestKg: round(latest.kg, 2),
    latestDate: latest.date,
    trendKg: round(trend, 2),
    measurements: points.length,
  };

  const spanDays = daysBetween(points[0].date, latest.date);
  if (points.length >= 3 && spanDays >= 7) {
    const xs = points.map((p) => daysBetween(points[0].date, p.date));
    const ys = points.map((p) => p.kg);
    const mx = mean(xs)!;
    const my = mean(ys)!;
    const denom = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    if (denom > 0) {
      const slopePerDay = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / denom;
      result.weeklyChangeKg = round(slopePerDay * 7, 2);
    }
  } else {
    result.note = "Need at least 3 weigh-ins spanning a week for a reliable rate";
  }

  if (goals.targetWeightKg !== undefined) {
    const remaining = trend - goals.targetWeightKg;
    result.targetKg = goals.targetWeightKg;
    result.remainingKg = round(remaining, 2);
    const weekly = result.weeklyChangeKg;
    if (weekly !== undefined && weekly !== 0 && Math.sign(weekly) === -Math.sign(remaining)) {
      result.projectedTargetDate = addDays(today, Math.round((Math.abs(remaining) / Math.abs(weekly)) * 7));
    }
    if (goals.targetDate && goals.targetDate > today) {
      const weeksLeft = daysBetween(today, goals.targetDate) / 7;
      result.requiredWeeklyChangeKg = round(-remaining / weeksLeft, 2);
    }
    if (goals.startWeightKg !== undefined && goals.startWeightKg !== goals.targetWeightKg) {
      const pct = ((goals.startWeightKg - trend) / (goals.startWeightKg - goals.targetWeightKg)) * 100;
      result.progressPct = round(pct, 0);
    }
  }
  return result;
}

interface TargetResult {
  target: number;
  actual?: number;
  daysMet?: number;
  daysWithData: number;
}

/** Compares a period of daily summaries with the user's goals. */
export function evaluateTargets(goals: Goals, days: DaySummary[]): Record<string, TargetResult> {
  const out: Record<string, TargetResult> = {};
  const n = days.length || 1;

  const daily = (goal: keyof Goals, key: NumericKey, met: (v: number, t: number) => boolean) => {
    const target = goals[goal];
    if (typeof target !== "number") return;
    const xs = values(days, key);
    out[goal] = {
      target,
      actual: round(mean(xs), 0),
      daysMet: xs.filter((v) => met(v, target)).length,
      daysWithData: xs.length,
    };
  };
  daily("dailySteps", "steps", (v, t) => v >= t);
  daily("dailyCaloriesKcal", "intakeKcal", (v, t) => Math.abs(v - t) <= t * 0.1);
  daily("dailyProteinG", "proteinG", (v, t) => v >= t * 0.9);
  daily("dailyCarbsG", "carbsG", (v, t) => Math.abs(v - t) <= t * 0.15);
  daily("dailyFatG", "fatG", (v, t) => Math.abs(v - t) <= t * 0.15);
  daily("dailyFiberG", "fiberG", (v, t) => v >= t);
  daily("dailyWaterMl", "waterMl", (v, t) => v >= t);
  daily("dailySleepMinutes", "sleepMinutes", (v, t) => v >= t);

  const weekly = (goal: keyof Goals, key: NumericKey) => {
    const target = goals[goal];
    if (typeof target !== "number") return;
    const xs = values(days, key);
    out[goal] = { target, actual: round((xs.reduce((a, b) => a + b, 0) * 7) / n, 1), daysWithData: xs.length };
  };
  weekly("weeklyActiveZoneMinutes", "activeZoneMinutes");
  weekly("weeklyWorkouts", "workouts");
  return out;
}

/** Average intake minus expenditure over days where both are known. */
export function energyBalance(days: DaySummary[]) {
  const both = days.filter((d) => d.intakeKcal !== undefined && d.totalKcal !== undefined);
  if (both.length === 0) {
    return { daysWithIntakeAndBurn: 0, note: "Needs days with both logged food and total calories burned" };
  }
  const intake = mean(both.map((d) => d.intakeKcal!))!;
  const burn = mean(both.map((d) => d.totalKcal!))!;
  const balance = intake - burn;
  return {
    daysWithIntakeAndBurn: both.length,
    avgIntakeKcal: round(intake, 0),
    avgBurnKcal: round(burn, 0),
    avgDailyBalanceKcal: round(balance, 0),
    impliedWeeklyChangeKg: round((balance * 7) / 7700, 2),
    note: "Rough estimate (7700 kcal ≈ 1 kg); only as accurate as food logging and device calorie estimates.",
  };
}
