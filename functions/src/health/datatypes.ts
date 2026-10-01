/**
 * Catalog of the Google Health API data types this server exposes, from the "Data types index"
 * guide. ECG, IRN, reproductive health, moods and symptoms are left out because the server doesn't
 * request their scopes.
 */

export type RecordKind = "interval" | "sample" | "daily" | "session" | "food";
export type ScopeGroup = "activity_and_fitness" | "health_metrics_and_measurements" | "sleep" | "nutrition";
export type Operation = "list" | "get" | "reconcile" | "rollUp" | "dailyRollUp" | "create" | "patch" | "batchDelete";

export interface DataTypeInfo {
  /** kebab-case id used in URLs, e.g. "body-fat". */
  id: string;
  /** camelCase key of the value in a DataPoint, e.g. "bodyFat". */
  field: string;
  /** snake_case name used in filters, e.g. "body_fat". */
  filterName: string;
  kind: RecordKind;
  scope: ScopeGroup;
  ops: Operation[];
  /** Maximum rollUp/dailyRollUp range. */
  maxRollupDays: number;
  /** Storage resolution; rollUp windows shouldn't be smaller. */
  resolutionSec?: number;
  description: string;
}

const READ = ["list", "reconcile"] as const;
const ROLLUPS = ["rollUp", "dailyRollUp"] as const;
const WRITE = ["create", "patch", "batchDelete"] as const;

function def(
  id: string,
  kind: RecordKind,
  scope: ScopeGroup,
  ops: readonly Operation[],
  description: string,
  extra: Partial<Pick<DataTypeInfo, "maxRollupDays" | "resolutionSec">> = {},
): DataTypeInfo {
  return {
    id,
    field: id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
    filterName: id.replace(/-/g, "_"),
    kind,
    scope,
    ops: [...ops],
    maxRollupDays: extra.maxRollupDays ?? 90,
    resolutionSec: extra.resolutionSec,
    description,
  };
}

const AF = "activity_and_fitness";
const HM = "health_metrics_and_measurements";

export const DATA_TYPES: DataTypeInfo[] = [
  def("steps", "interval", AF, [...READ, ...ROLLUPS], "Step count", { resolutionSec: 60 }),
  def("distance", "interval", AF, [...READ, ...ROLLUPS], "Distance traveled", { resolutionSec: 60 }),
  def("floors", "interval", AF, ["reconcile", ...ROLLUPS], "Floors climbed", { resolutionSec: 60 }),
  def("altitude", "interval", AF, [...READ, ...ROLLUPS], "Elevation gain", { resolutionSec: 60 }),
  def("active-minutes", "interval", AF, [...READ, ...ROLLUPS], "Active minutes by intensity (light/moderate/vigorous)", {
    maxRollupDays: 14,
    resolutionSec: 60,
  }),
  def("active-zone-minutes", "interval", AF, [...READ, ...ROLLUPS], "Active Zone Minutes (fat burn, cardio, peak)", {
    resolutionSec: 60,
  }),
  def("activity-level", "interval", AF, READ, "Activity level per interval (sedentary to very active)"),
  def("sedentary-period", "interval", AF, [...READ, ...ROLLUPS], "Sedentary periods while wearing a device"),
  def("time-in-heart-rate-zone", "interval", AF, [...READ, ...ROLLUPS], "Time in heart rate zones", { resolutionSec: 60 }),
  def("calories-in-heart-rate-zone", "interval", AF, ROLLUPS, "Calories burned per heart rate zone", {
    maxRollupDays: 14,
    resolutionSec: 60,
  }),
  def("total-calories", "interval", AF, ROLLUPS, "Total energy burned (BMR + activity)", {
    maxRollupDays: 14,
    resolutionSec: 60,
  }),
  def("active-energy-burned", "interval", AF, [...READ, ...ROLLUPS], "Active energy burned (excludes BMR)", {
    resolutionSec: 60,
  }),
  def("swim-lengths-data", "interval", AF, [...READ, ...ROLLUPS], "Swim lengths and strokes"),
  def("exercise", "session", AF, ["list", "get", "reconcile", ...WRITE], "Workout sessions"),
  def("vo2-max", "sample", AF, READ, "VO2 max measurements"),
  def("daily-vo2-max", "daily", AF, READ, "Daily cardio fitness score (VO2 max)"),
  def("run-vo2-max", "sample", AF, [...READ, ...ROLLUPS], "VO2 max from runs"),

  def("heart-rate", "sample", HM, [...READ, ...ROLLUPS], "Heart rate samples", { maxRollupDays: 14, resolutionSec: 1 }),
  def("daily-resting-heart-rate", "daily", HM, READ, "Daily resting heart rate"),
  def("heart-rate-variability", "sample", HM, READ, "Heart rate variability samples"),
  def("daily-heart-rate-variability", "daily", HM, READ, "Daily heart rate variability (RMSSD)"),
  def("daily-heart-rate-zones", "daily", HM, READ, "Personal heart rate zone boundaries per day"),
  def("oxygen-saturation", "sample", HM, READ, "SpO2 samples", { resolutionSec: 60 }),
  def("daily-oxygen-saturation", "daily", HM, READ, "Daily SpO2"),
  def("daily-respiratory-rate", "daily", HM, READ, "Daily respiratory rate"),
  def("respiratory-rate-sleep-summary", "sample", HM, READ, "Respiratory rate during sleep"),
  def("daily-sleep-temperature-derivations", "daily", HM, READ, "Nightly skin temperature variation"),
  def("core-body-temperature", "sample", HM, ["list", "get", "reconcile", ...ROLLUPS], "Core body temperature"),
  def("blood-glucose", "sample", HM, ["list", "get", "reconcile", ...ROLLUPS], "Blood glucose"),
  def("weight", "sample", HM, ["list", "get", "reconcile", ...ROLLUPS, ...WRITE], "Body weight"),
  def("body-fat", "sample", HM, ["list", "get", "reconcile", ...ROLLUPS, ...WRITE], "Body fat percentage"),
  def("height", "sample", HM, ["list", "get", "reconcile", ...WRITE], "Height"),

  def("sleep", "session", "sleep", ["list", "get", "reconcile", ...WRITE], "Sleep sessions with stages"),

  def("nutrition-log", "session", "nutrition", ["list", "get", "reconcile", ...ROLLUPS, ...WRITE], "Logged meals and foods"),
  def("hydration-log", "session", "nutrition", ["list", "get", "reconcile", ...ROLLUPS, ...WRITE], "Logged water intake"),
  def("food", "food", "nutrition", ["list", "get"], "Foods available to log (use the id with log_meal)"),
  def("food-measurement-unit", "food", "nutrition", ["list", "get"], "Serving measurement units"),
];

const BY_ID = new Map(DATA_TYPES.map((t) => [t.id, t]));

export function getDataType(id: string): DataTypeInfo {
  const info = BY_ID.get(id);
  if (!info) throw new Error(`Unknown data type "${id}". Known types: ${DATA_TYPES.map((t) => t.id).join(", ")}`);
  return info;
}

export function typesWith(op: Operation): string[] {
  return DATA_TYPES.filter((t) => t.ops.includes(op)).map((t) => t.id);
}

export function readScope(info: DataTypeInfo): string {
  return `${info.scope}.readonly`;
}

export function writeScope(info: DataTypeInfo): string {
  return `${info.scope}.writeonly`;
}

/**
 * AIP-160 filter selecting points whose civil (local) time falls in [start, endExclusive).
 * Each record kind filters on a different field; sleep is filtered by wake-up time.
 */
export function civilRangeFilter(info: DataTypeInfo, start?: string, endExclusive?: string): string | undefined {
  const f = info.filterName;
  let field: string;
  switch (info.kind) {
    case "interval":
      field = `${f}.interval.civil_start_time`;
      break;
    case "sample":
      field = `${f}.sample_time.civil_time`;
      break;
    case "daily":
      field = `${f}.date`;
      break;
    case "session":
      field = info.id === "sleep" ? "sleep.interval.civil_end_time" : `${f}.interval.civil_start_time`;
      break;
    case "food":
      return undefined;
  }
  const parts: string[] = [];
  if (start) parts.push(`${field} >= "${start}"`);
  if (endExclusive) parts.push(`${field} < "${endExclusive}"`);
  return parts.length ? parts.join(" AND ") : undefined;
}
