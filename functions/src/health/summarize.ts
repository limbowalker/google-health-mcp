import type { DataTypeInfo } from "./datatypes.js";
import type { Json } from "./client.js";
import { fromCivil, localFromPhysical, parseDuration } from "./time.js";

export function round(value: number | undefined | null, digits = 1): number | undefined {
  if (value === undefined || value === null || Number.isNaN(value)) return undefined;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function num(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return undefined;
}

const minutes = (duration: unknown) => round((parseDuration(duration as string) ?? NaN) / 60, 0);

/** Drops undefined/null values so tool output stays compact. */
export function clean<T extends Json>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)) as T;
}

/** "HEALTH_KIT · Apple Watch · com.apple.health" — lets the agent tell where data came from. */
export function sourceLabel(ds: Json | undefined): string | undefined {
  if (!ds) return undefined;
  const parts = [
    ds.platform,
    ds.device?.displayName ?? ds.device?.manufacturer,
    ds.application?.packageName,
    ds.recordingMethod && ds.recordingMethod !== "UNKNOWN" ? ds.recordingMethod.toLowerCase() : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function pointName(point: Json): string | undefined {
  return point.name || point.dataPointName || undefined;
}

/**
 * Generic compaction for any data point: local timestamps instead of physical+offset+civil
 * triples, numeric strings (int64) as numbers, and a one-line source label.
 */
export function compactPoint(point: Json, info: DataTypeInfo): Json {
  const value = point[info.field] ?? {};
  return clean({ id: pointName(point), source: sourceLabel(point.dataSource), ...simplify(value) });
}

function simplify(value: unknown): any {
  if (Array.isArray(value)) return value.map(simplify);
  if (typeof value === "string") return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  if (!value || typeof value !== "object") return value;
  const obj = value as Json;
  if ("physicalTime" in obj) return localFromPhysical(obj.physicalTime, obj.utcOffset);
  if ("startTime" in obj && "endTime" in obj && ("startUtcOffset" in obj || "civilStartTime" in obj)) {
    const rest = Object.fromEntries(
      Object.entries(obj).filter(([k]) => !/^(start|end)(Time|UtcOffset)$|^civil/.test(k)),
    );
    return clean({
      start: localFromPhysical(obj.startTime, obj.startUtcOffset),
      end: localFromPhysical(obj.endTime, obj.endUtcOffset),
      ...simplify(rest),
    });
  }
  if ("year" in obj && "month" in obj && "day" in obj && Object.keys(obj).length <= 3) return fromCivil(obj);
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("civil") || k === "createTime" || k === "updateTime") continue;
    out[k] = simplify(v);
  }
  return out;
}

export function summarizeExercise(point: Json): Json {
  const e = point.exercise ?? {};
  const m = e.metricsSummary ?? {};
  const zones = m.heartRateZoneDurations ?? {};
  const start = localFromPhysical(e.interval?.startTime, e.interval?.startUtcOffset);
  const durationSec =
    e.interval?.startTime && e.interval?.endTime
      ? (Date.parse(e.interval.endTime) - Date.parse(e.interval.startTime)) / 1000
      : undefined;
  return clean({
    id: pointName(point),
    type: e.exerciseType,
    name: e.displayName,
    start,
    end: localFromPhysical(e.interval?.endTime, e.interval?.endUtcOffset),
    durationMin: round((durationSec ?? NaN) / 60, 0),
    activeMin: minutes(e.activeDuration),
    distanceKm: round((num(m.distanceMillimeters) ?? NaN) / 1e6, 2),
    kcal: round(num(m.caloriesKcal), 0),
    steps: num(m.steps),
    avgHeartRate: num(m.averageHeartRateBeatsPerMinute),
    activeZoneMinutes: num(m.activeZoneMinutes),
    paceMinPerKm: m.averagePaceSecondsPerMeter ? round((num(m.averagePaceSecondsPerMeter)! * 1000) / 60, 2) : undefined,
    speedKmh: m.averageSpeedMillimetersPerSecond ? round(num(m.averageSpeedMillimetersPerSecond)! * 0.0036, 1) : undefined,
    elevationGainM: m.elevationGainMillimeters ? round(num(m.elevationGainMillimeters)! / 1000, 0) : undefined,
    heartRateZonesMin: Object.keys(zones).length
      ? clean({
          light: minutes(zones.lightTime),
          moderate: minutes(zones.moderateTime),
          vigorous: minutes(zones.vigorousTime),
          peak: minutes(zones.peakTime),
        })
      : undefined,
    runVo2Max: num(m.runVo2Max),
    swimLengths: num(m.totalSwimLengths),
    notes: e.notes,
    source: sourceLabel(point.dataSource),
  });
}

export function summarizeSleep(point: Json): Json {
  const s = point.sleep ?? {};
  const sum = s.summary ?? {};
  const asleep = num(sum.minutesAsleep);
  const inPeriod = num(sum.minutesInSleepPeriod);
  const stages: Json = {};
  for (const st of sum.stagesSummary ?? []) {
    if (st.type) stages[String(st.type).toLowerCase()] = num(st.minutes);
  }
  const end = localFromPhysical(s.interval?.endTime, s.interval?.endUtcOffset);
  return clean({
    id: pointName(point),
    date: end?.slice(0, 10),
    start: localFromPhysical(s.interval?.startTime, s.interval?.startUtcOffset),
    end,
    mainSleep: s.metadata?.mainSleep,
    nap: s.metadata?.nap || undefined,
    type: s.type,
    minutesAsleep: asleep,
    minutesAwake: num(sum.minutesAwake),
    minutesInSleepPeriod: inPeriod,
    efficiencyPct: asleep !== undefined && inPeriod ? round((asleep / inPeriod) * 100, 0) : undefined,
    minutesToFallAsleep: num(sum.minutesToFallAsleep),
    stagesMin: Object.keys(stages).length ? stages : undefined,
    source: sourceLabel(point.dataSource),
  });
}

function nutrient(list: Json[] | undefined, name: string): number | undefined {
  const found = (list ?? []).find((n) => n.nutrient === name);
  return num(found?.quantity?.grams ?? found?.quantity?.gramsSum);
}

export function summarizeNutritionLog(point: Json): Json {
  const n = point.nutritionLog ?? {};
  const time = localFromPhysical(n.interval?.startTime, n.interval?.startUtcOffset);
  const sodium = nutrient(n.nutrients, "SODIUM");
  return clean({
    id: pointName(point),
    date: time?.slice(0, 10),
    time,
    meal: n.mealType,
    name: n.foodDisplayName,
    servings: num(n.serving?.amount),
    servingUnit: n.serving?.foodMeasurementUnitDisplayName,
    kcal: round(num(n.energy?.kcal), 0),
    proteinG: round(nutrient(n.nutrients, "PROTEIN")),
    carbsG: round(num(n.totalCarbohydrate?.grams) ?? nutrient(n.nutrients, "CARBOHYDRATES")),
    fatG: round(num(n.totalFat?.grams)),
    fiberG: round(nutrient(n.nutrients, "DIETARY_FIBER")),
    sugarG: round(nutrient(n.nutrients, "SUGAR")),
    sodiumMg: sodium !== undefined ? round(sodium * 1000, 0) : undefined,
    source: sourceLabel(point.dataSource),
  });
}

/** Rollup value (RollupDataPoint / DailyRollupDataPoint member) → flat numbers in human units. */
export function simplifyRollup(type: string, point: Json): Json {
  const field = type.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const v = point[field];
  if (!v) return {};
  switch (type) {
    case "steps":
      return { steps: num(v.countSum) };
    case "distance":
      return { km: round((num(v.millimetersSum) ?? 0) / 1e6, 2) };
    case "floors":
      return { floors: num(v.countSum) };
    case "altitude":
      return { elevationGainM: round((num(v.gainMillimetersSum) ?? 0) / 1000, 0) };
    case "total-calories":
    case "active-energy-burned":
      return { kcal: round(num(v.kcalSum), 0) };
    case "heart-rate":
      return clean({ avgBpm: round(num(v.beatsPerMinuteAvg), 0), minBpm: num(v.beatsPerMinuteMin), maxBpm: num(v.beatsPerMinuteMax) });
    case "weight":
      return { kg: round((num(v.weightGramsAvg) ?? NaN) / 1000, 2) };
    case "body-fat":
      return { pct: round(num(v.bodyFatPercentageAvg), 1) };
    case "active-zone-minutes": {
      const fatBurn = num(v.sumInFatBurnHeartZone) ?? 0;
      const cardio = num(v.sumInCardioHeartZone) ?? 0;
      const peak = num(v.sumInPeakHeartZone) ?? 0;
      return { total: fatBurn + cardio + peak, fatBurn, cardio, peak };
    }
    case "active-minutes": {
      const out: Json = {};
      for (const l of v.activeMinutesRollupByActivityLevel ?? []) out[String(l.activityLevel).toLowerCase()] = num(l.activeMinutesSum);
      return out;
    }
    case "sedentary-period":
      return { minutes: minutes(v.durationSum) };
    case "time-in-heart-rate-zone": {
      const out: Json = {};
      for (const z of v.timeInHeartRateZones ?? []) out[`${String(z.heartRateZone).toLowerCase()}Min`] = minutes(z.duration);
      return out;
    }
    case "calories-in-heart-rate-zone": {
      const out: Json = {};
      for (const z of v.caloriesInHeartRateZones ?? []) out[`${String(z.heartRateZone).toLowerCase()}Kcal`] = round(num(z.kcal), 0);
      return out;
    }
    case "nutrition-log": {
      const sodium = nutrient(v.nutrients, "SODIUM");
      return clean({
        kcal: round(num(v.energy?.kcalSum), 0),
        proteinG: round(nutrient(v.nutrients, "PROTEIN")),
        carbsG: round(num(v.totalCarbohydrate?.gramsSum) ?? nutrient(v.nutrients, "CARBOHYDRATES")),
        fatG: round(num(v.totalFat?.gramsSum)),
        fiberG: round(nutrient(v.nutrients, "DIETARY_FIBER")),
        sugarG: round(nutrient(v.nutrients, "SUGAR")),
        sodiumMg: sodium !== undefined ? round(sodium * 1000, 0) : undefined,
      });
    }
    case "hydration-log":
      return { ml: round(num(v.amountConsumed?.millilitersSum), 0) };
    case "run-vo2-max":
      return clean({ avg: round(num(v.rateAvg)), min: round(num(v.rateMin)), max: round(num(v.rateMax)) });
    case "blood-glucose":
      return { mgPerDlAvg: round(num(v.bloodGlucoseMilligramsPerDeciliterAvg)) };
    case "core-body-temperature":
      return clean({ avgC: round(num(v.temperatureCelsiusAvg), 2), minC: num(v.temperatureCelsiusMin), maxC: num(v.temperatureCelsiusMax) });
    case "swim-lengths-data":
      return { strokes: num(v.strokeCountSum) };
    default:
      return simplify(v);
  }
}

/** Date ("YYYY-MM-DD") of a daily rollup entry. */
export function rollupDate(point: Json): string | undefined {
  return fromCivil(point.civilStartTime?.date);
}
