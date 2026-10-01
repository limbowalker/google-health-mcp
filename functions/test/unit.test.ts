import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/auth/crypto.js";
import { buildConfig, isEmailAllowed } from "../src/config.js";
import { civilRangeFilter, getDataType } from "../src/health/datatypes.js";
import { simplifyRollup, summarizeExercise, summarizeNutritionLog, summarizeSleep } from "../src/health/summarize.js";
import {
  addDays,
  formatLocal,
  localFromPhysical,
  offsetSeconds,
  parseDateTime,
  resolveRange,
} from "../src/health/time.js";
import { energyBalance, evaluateTargets, weightTrend } from "../src/mcp/goals.js";
import { runTool } from "../src/mcp/context.js";

describe("tool results", () => {
  it("refuses results larger than Claude's limits", async () => {
    const ok = await runTool(async () => ({ rows: "x".repeat(1000) }));
    expect(ok.isError).toBeUndefined();
    const big = await runTool(async () => ({ rows: "x".repeat(200_000) }));
    expect(big.isError).toBe(true);
    expect((big.content[0] as { text: string }).text).toMatch(/too large/);
  });
});

describe("time helpers", () => {
  it("computes UTC offsets across DST", () => {
    expect(offsetSeconds("Europe/Warsaw", new Date("2026-07-01T12:00:00Z"))).toBe(7200);
    expect(offsetSeconds("Europe/Warsaw", new Date("2026-01-15T12:00:00Z"))).toBe(3600);
    expect(offsetSeconds("America/Los_Angeles", new Date("2026-01-15T12:00:00Z"))).toBe(-28800);
  });

  it("parses local and absolute times", () => {
    expect(parseDateTime("2026-07-01T08:30", "Europe/Warsaw").toISOString()).toBe("2026-07-01T06:30:00.000Z");
    expect(parseDateTime("2026-01-15", "America/New_York").toISOString()).toBe("2026-01-15T05:00:00.000Z");
    expect(parseDateTime("2026-07-01T08:30:00Z", "Europe/Warsaw").toISOString()).toBe("2026-07-01T08:30:00.000Z");
    expect(parseDateTime("2026-07-01T08:30:00-04:00", "UTC").toISOString()).toBe("2026-07-01T12:30:00.000Z");
    expect(() => parseDateTime("yesterday", "UTC")).toThrow(/Invalid date/);
  });

  it("handles the spring-forward gap", () => {
    // 02:30 doesn't exist in Warsaw on 2026-03-29; it resolves to an adjacent valid instant.
    const at = parseDateTime("2026-03-29T02:30", "Europe/Warsaw");
    expect(["2026-03-29T00:30:00.000Z", "2026-03-29T01:30:00.000Z"]).toContain(at.toISOString());
  });

  it("formats local timestamps", () => {
    expect(formatLocal(new Date("2026-07-01T06:30:00Z"), "Europe/Warsaw")).toBe("2026-07-01T08:30:00+02:00");
    expect(localFromPhysical("2026-06-16T18:00:00Z", "-14400s")).toBe("2026-06-16T14:00:00-04:00");
  });

  it("resolves date ranges", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    const r = resolveRange({ startDate: "2026-09-01", endDate: "2026-09-07" }, "UTC", 14, 90);
    expect(r).toEqual({ start: "2026-09-01", end: "2026-09-07", endExclusive: "2026-09-08", days: 7 });
    expect(() => resolveRange({ startDate: "2026-01-01", endDate: "2026-09-07" }, "UTC", 14, 90)).toThrow(/too long/);
    expect(() => resolveRange({ startDate: "2026-09-08", endDate: "2026-09-07" }, "UTC", 14, 90)).toThrow();
    expect(() => resolveRange({ startDate: "2026-02-30" }, "UTC", 14, 90)).toThrow(/real date/);
  });
});

describe("filters", () => {
  it("uses the right field per record kind", () => {
    expect(civilRangeFilter(getDataType("steps"), "2026-09-01", "2026-09-02")).toBe(
      'steps.interval.civil_start_time >= "2026-09-01" AND steps.interval.civil_start_time < "2026-09-02"',
    );
    expect(civilRangeFilter(getDataType("body-fat"), "2026-09-01")).toBe('body_fat.sample_time.civil_time >= "2026-09-01"');
    expect(civilRangeFilter(getDataType("daily-resting-heart-rate"), undefined, "2026-09-02")).toBe(
      'daily_resting_heart_rate.date < "2026-09-02"',
    );
    expect(civilRangeFilter(getDataType("sleep"), "2026-09-01")).toBe('sleep.interval.civil_end_time >= "2026-09-01"');
    expect(civilRangeFilter(getDataType("exercise"), "2026-09-01")).toBe('exercise.interval.civil_start_time >= "2026-09-01"');
    expect(civilRangeFilter(getDataType("food"), "2026-09-01")).toBeUndefined();
  });
});

describe("summaries", () => {
  it("summarizes a workout", () => {
    const w = summarizeExercise({
      name: "users/1/dataTypes/exercise/dataPoints/42",
      dataSource: { platform: "HEALTH_KIT", device: { displayName: "Apple Watch" }, recordingMethod: "ACTIVELY_MEASURED" },
      exercise: {
        interval: { startTime: "2026-04-20T08:00:00Z", startUtcOffset: "7200s", endTime: "2026-04-20T08:35:00Z", endUtcOffset: "7200s" },
        exerciseType: "RUNNING",
        displayName: "Run",
        activeDuration: "1800s",
        metricsSummary: {
          caloriesKcal: 380,
          distanceMillimeters: 5000000,
          steps: "6200",
          averagePaceSecondsPerMeter: 0.36,
          averageHeartRateBeatsPerMinute: "148",
          heartRateZoneDurations: { moderateTime: "600s", vigorousTime: "1200s" },
        },
      },
    });
    expect(w).toMatchObject({
      id: "users/1/dataTypes/exercise/dataPoints/42",
      type: "RUNNING",
      start: "2026-04-20T10:00:00+02:00",
      durationMin: 35,
      activeMin: 30,
      distanceKm: 5,
      kcal: 380,
      steps: 6200,
      avgHeartRate: 148,
      paceMinPerKm: 6,
      heartRateZonesMin: { moderate: 10, vigorous: 20 },
      source: "HEALTH_KIT · Apple Watch · actively_measured",
    });
  });

  it("summarizes sleep by wake-up date", () => {
    const s = summarizeSleep({
      sleep: {
        interval: { startTime: "2026-03-03T20:57:30Z", startUtcOffset: "0s", endTime: "2026-03-04T04:41:30Z", endUtcOffset: "0s" },
        metadata: { mainSleep: true },
        summary: {
          minutesAsleep: "420",
          minutesInSleepPeriod: "464",
          stagesSummary: [
            { type: "DEEP", minutes: "80" },
            { type: "REM", minutes: "95" },
          ],
        },
      },
    });
    expect(s).toMatchObject({ date: "2026-03-04", minutesAsleep: 420, efficiencyPct: 91, stagesMin: { deep: 80, rem: 95 } });
  });

  it("summarizes a nutrition log", () => {
    const n = summarizeNutritionLog({
      nutritionLog: {
        interval: { startTime: "2026-06-16T18:00:00Z", startUtcOffset: "0s", endTime: "2026-06-16T18:30:00Z", endUtcOffset: "0s" },
        foodDisplayName: "Grilled Chicken Breast",
        mealType: "DINNER",
        energy: { kcal: 165 },
        totalCarbohydrate: { grams: 0 },
        totalFat: { grams: 3.6 },
        nutrients: [
          { nutrient: "PROTEIN", quantity: { grams: 31 } },
          { nutrient: "SODIUM", quantity: { grams: 0.074 } },
        ],
      },
    });
    expect(n).toMatchObject({ date: "2026-06-16", meal: "DINNER", kcal: 165, proteinG: 31, carbsG: 0, fatG: 3.6, sodiumMg: 74 });
  });

  it("simplifies rollups", () => {
    expect(simplifyRollup("steps", { steps: { countSum: "8123" } })).toEqual({ steps: 8123 });
    expect(simplifyRollup("weight", { weight: { weightGramsAvg: 81234 } })).toEqual({ kg: 81.23 });
    expect(
      simplifyRollup("active-zone-minutes", {
        activeZoneMinutes: { sumInFatBurnHeartZone: "10", sumInCardioHeartZone: "20", sumInPeakHeartZone: "4" },
      }),
    ).toEqual({ total: 34, fatBurn: 10, cardio: 20, peak: 4 });
    expect(
      simplifyRollup("nutrition-log", {
        nutritionLog: {
          energy: { kcalSum: 2100 },
          totalFat: { gramsSum: 70 },
          nutrients: [{ nutrient: "PROTEIN", quantity: { gramsSum: 150 } }],
        },
      }),
    ).toEqual({ kcal: 2100, proteinG: 150, fatG: 70 });
  });
});

describe("goal math", () => {
  const series = Array.from({ length: 22 }, (_, i) => ({
    date: addDays("2026-09-01", i),
    kg: 90 - i * 0.1 + (i % 2 ? 0.4 : -0.4),
  }));

  it("computes a weight trend and projection", () => {
    const t = weightTrend(series, { targetWeightKg: 85, targetDate: "2026-12-31", startWeightKg: 90 }, "2026-09-22");
    expect(t.measurements).toBe(22);
    expect(t.weeklyChangeKg).toBeCloseTo(-0.7, 1);
    expect(t.remainingKg).toBeGreaterThan(3);
    expect(t.projectedTargetDate! > "2026-09-22").toBe(true);
    expect(t.requiredWeeklyChangeKg).toBeLessThan(0);
  });

  it("evaluates targets and energy balance", () => {
    const days = [
      { date: "2026-09-01", steps: 12000, intakeKcal: 2000, totalKcal: 2600, proteinG: 150, workouts: 1, activeZoneMinutes: 40 },
      { date: "2026-09-02", steps: 6000, intakeKcal: 2300, totalKcal: 2400, proteinG: 120 },
    ];
    const r = evaluateTargets({ dailySteps: 10000, dailyCaloriesKcal: 2100, dailyProteinG: 140, weeklyWorkouts: 3 }, days);
    expect(r.dailySteps).toEqual({ target: 10000, actual: 9000, daysMet: 1, daysWithData: 2 });
    expect(r.dailyCaloriesKcal.daysMet).toBe(2);
    expect(r.dailyProteinG.daysMet).toBe(1);
    expect(r.weeklyWorkouts.actual).toBe(3.5);
    const e = energyBalance(days);
    expect(e).toMatchObject({ avgIntakeKcal: 2150, avgBurnKcal: 2500, avgDailyBalanceKcal: -350 });
  });
});

describe("config and crypto", () => {
  const config = buildConfig({
    baseUrl: "https://example.web.app/some/path?x=1",
    googleClientId: "id",
    googleClientSecret: "secret",
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    allowedEmails: "me@example.com, @corp.example",
  });

  it("normalizes the base URL and parses the allowlist", () => {
    expect(config.baseUrl.href).toBe("https://example.web.app/");
    expect(isEmailAllowed(config, "ME@example.com")).toBe(true);
    expect(isEmailAllowed(config, "anyone@corp.example")).toBe(true);
    expect(isEmailAllowed(config, "other@example.com")).toBe(false);
    expect(isEmailAllowed(config, undefined)).toBe(false);
  });

  it("round-trips encryption and detects tampering", () => {
    const enc = encrypt("refresh-token", config.encryptionKey);
    expect(decrypt(enc, config.encryptionKey)).toBe("refresh-token");
    const tampered = enc.slice(0, -2) + (enc.endsWith("A") ? "BB" : "AA");
    expect(() => decrypt(tampered, config.encryptionKey)).toThrow();
  });

  it("rejects bad keys", () => {
    expect(() => buildConfig({ baseUrl: "https://x", googleClientId: "a", googleClientSecret: "b", encryptionKey: "short" })).toThrow(
      /32 bytes/,
    );
  });
});
