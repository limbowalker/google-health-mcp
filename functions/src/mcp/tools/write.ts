import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Json } from "../../health/client.js";
import { getDataType, writeScope } from "../../health/datatypes.js";
import { clean, compactPoint } from "../../health/summarize.js";
import { durationString, offsetSeconds, parseDateTime } from "../../health/time.js";
import { requireScope, runTool, UserInputError, type ToolContext } from "../context.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const MEAL_TYPES = [
  "BREAKFAST", "LUNCH", "DINNER", "SNACK", "BEFORE_BREAKFAST", "BEFORE_LUNCH", "BEFORE_DINNER", "AFTER_DINNER", "ANYTIME",
] as const;

// From the Exercise.exerciseType enum in the v4 discovery document.
const EXERCISE_TYPES = [
  "AEROBIC_WORKOUT", "ARCHERY", "ASSAULT_BIKE", "BACKPACKING", "BADMINTON", "BALLET", "BALLROOM_DANCE", "BARRE_CLASS",
  "BASEBALL", "BASKETBALL", "BIKING", "BILLIARDS", "BODY_WEIGHT", "BOOTCAMP", "BOWLING", "BOXING", "BREAKDANCING",
  "CALISTHENICS", "CANOEING", "CARDIO_SCULPT", "CARDIO_WORKOUT", "CARPENTRY", "CHEERLEADING", "CIRCUIT_TRAINING",
  "CLEANING", "CLIMBING", "CORE_TRAINING", "CRICKET", "CROQUET", "CROSS_COUNTRY_SKI", "CROSS_TRAINING", "CROSSFIT",
  "CURLING", "DANCING", "DIVING", "ELECTRIC_BIKE", "ELECTRIC_SCOOTER", "ELLIPTICAL", "EQUESTRIAN_SPORTS",
  "EXERCISE_CLASS", "FENCING", "FIELD_HOCKEY", "FISHING", "FITNESS_GAMING", "FOILING", "FOOTBALL_AMERICAN",
  "FOOTBALL_AUSTRALIAN", "FREE_WEIGHTS", "FRISBEE_PLAYING_GENERAL", "FUNCTIONAL_STRENGTH_TRAINING", "GARDENING", "GOLF",
  "GYMNASTICS", "HANDBALL", "HAND_CYCLING", "HIIT", "HIKING", "HIP_HOP", "HOCKEY", "HOEING", "HOUSEHOLD_CHORES",
  "HUNTING", "ICE_SKATING", "INCLINE_RUN", "INCLINE_WALK", "INDOOR_CLIMBING", "INTERVAL_WORKOUT", "JAZZ_DANCE",
  "JIU_JITSU", "JUMPING_ROPE", "KARATE", "KAYAKING", "KICKBOXING", "KITESURFING", "LACROSSE", "MARTIAL_ARTS", "MEDITATE",
  "MODERN_DANCE", "MOTOCROSS", "MOTORCYCLE", "MOUNTAIN_BIKE", "MOWING_LAWN", "MUAY_THAI", "MULTISPORT",
  "MUSICAL_PERFORMANCE", "NORDIC_WALKING", "ORIENTEERING", "OTHER", "OUTDOOR_BIKE", "OUTDOOR_WORKOUT", "PADDLEBOARDING",
  "PADEL", "PAINTING", "PARAGLIDING", "PARKOUR", "PICKELBALL", "PILATES", "POLO", "POWERLIFTING", "POWER_WALKING",
  "RACKET_SPORTS", "RACQUETBALL", "RESISTANCE_BANDS", "ROCK_CLIMBING", "ROLLERBLADING", "ROLLER_SKATING", "ROWING",
  "ROWING_MACHINE", "RUCKING", "RUGBY", "RUNNING", "SAILING", "SCOOTERING", "SCUBA_DIVING", "SHOOTING", "SHOVELING",
  "SKATEBOARDING", "SKATING", "SKIING", "SKYDIVING", "SNORKELING", "SNOWBOARDING", "SNOWMOBILING", "SNOWSHOEING",
  "SNOW_SPORT", "SOCCER", "SOFTBALL", "SPEED_SKATING", "SPINNING", "SPORT", "SQUASH", "STAIRCLIMBER", "STATIONARY_BIKE",
  "STEP_TRAINING", "STRENGTH_TRAINING", "STRETCHING", "STROLLER_WALK", "SURFING", "SWIMMING", "SWIMMING_OPEN_WATER",
  "SWIMMING_POOL", "SYNCHRONIZED_SWIMMING", "TABATA_WORKOUT", "TABLE_TENNIS", "TAEKWONDO", "TAI_CHI", "TANGO", "TENNIS",
  "TRACK_AND_FIELD", "TRAIL_RUN", "TRAMPOLINE", "TREADMILL", "TREADMILL_WALK", "TRX", "ULTIMATE_FRISBEE", "UNICYCLING",
  "VOLLEYBALL", "VOLLEYBALL_BEACH", "WAKEBOARDING", "WALKING", "WALK_WITH_WEIGHTS", "WATER_AEROBICS", "WATER_JOGGING",
  "WATER_POLO", "WATER_SKIING", "WATER_SPORT", "WATER_VOLLEYBALL", "WEEDING", "WEIGHTLIFTING", "WEIGHT_MACHINES",
  "WEIGHTS", "WHEELCHAIR", "WINDSURFING", "WORKOUT", "WRESTLING", "YOGA", "YOGA_BIKRAM", "YOGA_HATHA", "YOGA_POWER",
  "YOGA_VINYASA", "ZUMBA",
] as const;

const timeArg = (what: string) =>
  z.string().describe(`${what}: local time YYYY-MM-DDTHH:mm in the user's timezone, or an ISO 8601 timestamp with offset`);

const MANUAL = { recordingMethod: "MANUAL" };
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function resolveTime(input: string | undefined, tz: string, what: string): Date {
  const at = input ? parseDateTime(input, tz) : new Date();
  if (at.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw new UserInputError(`${what} is in the future`);
  return at;
}

function interval(start: Date, end: Date, tz: string) {
  return {
    startTime: start.toISOString(),
    startUtcOffset: durationString(offsetSeconds(tz, start)),
    endTime: end.toISOString(),
    endUtcOffset: durationString(offsetSeconds(tz, end)),
  };
}

function sampleTime(at: Date, tz: string) {
  return { physicalTime: at.toISOString(), utcOffset: durationString(offsetSeconds(tz, at)) };
}

/** Short interval for point-in-time logs, never extending past now. */
function shortInterval(at: Date, seconds: number, tz: string) {
  const now = Date.now();
  const end = new Date(Math.min(at.getTime() + seconds * 1000, now));
  const start = end.getTime() > at.getTime() ? at : new Date(end.getTime() - seconds * 1000);
  return interval(start, end, tz);
}

/** create returns a long-running Operation; in practice it completes synchronously. */
function operationResult(op: Json, type: string): Json {
  if (op.error) throw new Error(op.error.message ?? "Write failed");
  if (op.done && op.response) return compactPoint(op.response, getDataType(type));
  return { operation: op.name, done: Boolean(op.done) };
}

function normalizeName(name: string, type: string): string {
  if (name.startsWith("users/")) return name.replace(/^users\/[^/]+/, "users/me");
  return `users/me/dataTypes/${type}/dataPoints/${name}`;
}

export function registerWriteTools(server: McpServer, ctx: ToolContext) {
  const can = (scope: string) => ctx.scopes.has(scope);

  if (can("nutrition.writeonly")) {
    server.registerTool(
      "log_meal",
      {
        title: "Log a meal",
        description:
          "Logs food to Google Health. Either give a name with nutrition values (kcal required; estimate macros from " +
          "the description if the user doesn't know them, and say they're estimates), or a foodId from " +
          "list_data_points(dataType='food'). Free-form entries can't be edited later, only deleted and re-logged.",
        inputSchema: {
          name: z.string().max(200).optional().describe("Food name, e.g. 'Greek yogurt with honey'"),
          kcal: z.number().min(0).max(10000).optional(),
          proteinG: z.number().min(0).max(1000).optional(),
          carbsG: z.number().min(0).max(2000).optional(),
          fatG: z.number().min(0).max(1000).optional(),
          fiberG: z.number().min(0).max(500).optional(),
          sugarG: z.number().min(0).max(1000).optional(),
          saturatedFatG: z.number().min(0).max(500).optional(),
          sodiumMg: z.number().min(0).max(50000).optional(),
          mealType: z.enum(MEAL_TYPES).optional().describe("Default ANYTIME"),
          time: z.string().optional().describe("When it was eaten (local YYYY-MM-DDTHH:mm); default now"),
          servings: z.number().min(0.01).max(100).optional().describe("Number of servings (default 1)"),
          foodId: z.string().optional().describe("Id or resource name of a Food to log instead of free-form values"),
          servingUnit: z.string().optional().describe("With foodId: id or resource name of a food-measurement-unit"),
        },
        annotations: WRITE,
      },
      (a) =>
        runTool(async () => {
          const tz = await ctx.timeZone();
          const at = resolveTime(a.time, tz, "time");
          const base = { interval: shortInterval(at, 60, tz), mealType: a.mealType ?? "ANYTIME" };
          let nutritionLog: Json;
          if (a.foodId) {
            nutritionLog = {
              ...base,
              food: normalizeName(a.foodId, "food"),
              serving: clean({
                amount: a.servings ?? 1,
                foodMeasurementUnit: a.servingUnit ? normalizeName(a.servingUnit, "food-measurement-unit") : undefined,
              }),
            };
          } else {
            if (!a.name || a.kcal === undefined) throw new UserInputError("Provide name and kcal, or a foodId");
            const nutrients = (
              [
                ["PROTEIN", a.proteinG],
                ["DIETARY_FIBER", a.fiberG],
                ["SUGAR", a.sugarG],
                ["SATURATED_FAT", a.saturatedFatG],
                ["SODIUM", a.sodiumMg !== undefined ? a.sodiumMg / 1000 : undefined],
              ] as const
            )
              .filter(([, grams]) => grams !== undefined)
              .map(([nutrient, grams]) => ({ nutrient, quantity: { grams } }));
            nutritionLog = clean({
              ...base,
              foodDisplayName: a.name,
              energy: { kcal: a.kcal },
              totalCarbohydrate: a.carbsG !== undefined ? { grams: a.carbsG } : undefined,
              totalFat: a.fatG !== undefined ? { grams: a.fatG } : undefined,
              nutrients: nutrients.length ? nutrients : undefined,
              serving: { amount: a.servings ?? 1 },
            });
          }
          const op = await ctx.health.create("nutrition-log", { dataSource: MANUAL, nutritionLog });
          return { logged: operationResult(op, "nutrition-log") };
        }),
    );

    server.registerTool(
      "log_water",
      {
        title: "Log water",
        description: "Logs water (or other liquid) intake to Google Health.",
        inputSchema: {
          amount: z.number().min(1).max(10000),
          unit: z.enum(["ml", "l", "fl_oz_us", "cup_us"]).optional().describe("Default ml"),
          time: z.string().optional().describe("When (local YYYY-MM-DDTHH:mm); default now"),
        },
        annotations: WRITE,
      },
      ({ amount, unit = "ml", time }) =>
        runTool(async () => {
          const tz = await ctx.timeZone();
          const at = resolveTime(time, tz, "time");
          const factor = { ml: 1, l: 1000, fl_oz_us: 29.5735, cup_us: 236.588 }[unit];
          const userProvidedUnit = { ml: "MILLILITER", l: "LITER", fl_oz_us: "FLUID_OUNCE_US", cup_us: "CUP_US" }[unit];
          const op = await ctx.health.create("hydration-log", {
            dataSource: MANUAL,
            hydrationLog: {
              interval: shortInterval(at, 1, tz),
              amountConsumed: { milliliters: Math.round(amount * factor * 10) / 10, userProvidedUnit },
            },
          });
          return { logged: operationResult(op, "hydration-log") };
        }),
    );
  }

  if (can("health_metrics_and_measurements.writeonly")) {
    server.registerTool(
      "log_body_measurement",
      {
        title: "Log weight / body fat",
        description: "Logs a weigh-in (weight and/or body fat percentage) to Google Health.",
        inputSchema: {
          weight: z.number().min(10).max(1000).optional(),
          weightUnit: z.enum(["kg", "lb", "st"]).optional().describe("Default kg"),
          bodyFatPct: z.number().min(1).max(80).optional(),
          time: z.string().optional().describe("When measured (local YYYY-MM-DDTHH:mm); default now"),
          notes: z.string().max(500).optional(),
        },
        annotations: WRITE,
      },
      ({ weight, weightUnit = "kg", bodyFatPct, time, notes }) =>
        runTool(async () => {
          if (weight === undefined && bodyFatPct === undefined) throw new UserInputError("Provide weight and/or bodyFatPct");
          const tz = await ctx.timeZone();
          const at = sampleTime(resolveTime(time, tz, "time"), tz);
          const logged: Json = {};
          if (weight !== undefined) {
            const grams = weight * { kg: 1000, lb: 453.59237, st: 6350.29318 }[weightUnit];
            const op = await ctx.health.create("weight", {
              dataSource: MANUAL,
              weight: clean({ weightGrams: Math.round(grams), sampleTime: at, notes }),
            });
            logged.weight = operationResult(op, "weight");
          }
          if (bodyFatPct !== undefined) {
            const op = await ctx.health.create("body-fat", {
              dataSource: MANUAL,
              bodyFat: { percentage: bodyFatPct, sampleTime: at },
            });
            logged.bodyFat = operationResult(op, "body-fat");
          }
          return { logged };
        }),
    );
  }

  if (can("activity_and_fitness.writeonly")) {
    server.registerTool(
      "log_workout",
      {
        title: "Log a workout",
        description:
          "Logs a workout session to Google Health (e.g. a gym session or a run recorded without a device). For types " +
          "other than OTHER, Google Health names the workout after its type.",
        inputSchema: {
          exerciseType: z.enum(EXERCISE_TYPES),
          start: timeArg("Start time"),
          durationMinutes: z.number().min(1).max(1440),
          activeMinutes: z.number().min(0).max(1440).optional().describe("Duration excluding pauses; default = duration"),
          kcal: z.number().min(0).max(20000).optional(),
          distanceKm: z.number().min(0).max(1000).optional(),
          steps: z.number().int().min(0).max(200000).optional(),
          avgHeartRate: z.number().int().min(30).max(250).optional(),
          name: z.string().max(100).optional().describe("Display name, used when exerciseType is OTHER"),
          notes: z.string().max(1000).optional(),
        },
        annotations: WRITE,
      },
      (a) =>
        runTool(async () => {
          const tz = await ctx.timeZone();
          const start = parseDateTime(a.start, tz);
          const end = new Date(start.getTime() + a.durationMinutes * 60_000);
          if (end.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw new UserInputError("The workout would end in the future");
          const displayName =
            a.name ?? a.exerciseType.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
          const op = await ctx.health.create("exercise", {
            dataSource: MANUAL,
            exercise: clean({
              interval: interval(start, end, tz),
              exerciseType: a.exerciseType,
              displayName,
              activeDuration: durationString((a.activeMinutes ?? a.durationMinutes) * 60),
              metricsSummary: clean({
                caloriesKcal: a.kcal,
                distanceMillimeters: a.distanceKm !== undefined ? a.distanceKm * 1e6 : undefined,
                steps: a.steps !== undefined ? String(a.steps) : undefined,
                averageHeartRateBeatsPerMinute: a.avgHeartRate !== undefined ? String(a.avgHeartRate) : undefined,
              }),
              notes: a.notes,
            }),
          });
          return { logged: operationResult(op, "exercise") };
        }),
    );
  }

  if (can("sleep.writeonly")) {
    server.registerTool(
      "log_sleep",
      {
        title: "Log sleep",
        description: "Logs a sleep session (bedtime to wake time) to Google Health, e.g. a night without a device.",
        inputSchema: { start: timeArg("Fell asleep"), end: timeArg("Woke up") },
        annotations: WRITE,
      },
      ({ start, end }) =>
        runTool(async () => {
          const tz = await ctx.timeZone();
          const s = parseDateTime(start, tz);
          const e = resolveTime(end, tz, "end");
          if (e <= s) throw new UserInputError("end must be after start");
          if (e.getTime() - s.getTime() > 24 * 3600_000) throw new UserInputError("A sleep session can't exceed 24 hours");
          const op = await ctx.health.create("sleep", { dataSource: MANUAL, sleep: { interval: interval(s, e, tz) } });
          return { logged: operationResult(op, "sleep") };
        }),
    );
  }

  const writable = ["nutrition-log", "hydration-log", "weight", "body-fat", "height", "exercise", "sleep"];
  if (writable.some((t) => can(writeScope(getDataType(t))))) {
    server.registerTool(
      "delete_entries",
      {
        title: "Delete entries",
        description:
          "Permanently deletes entries by id (as returned by the log_* tools, get_nutrition_logs, get_workouts or " +
          "list_data_points). Google Health only allows deleting entries created by this server. Always confirm with " +
          "the user first.",
        inputSchema: {
          ids: z
            .array(z.string())
            .min(1)
            .max(100)
            .describe("Resource names like users/…/dataTypes/nutrition-log/dataPoints/…"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      ({ ids }) =>
        runTool(async () => {
          const byType = new Map<string, string[]>();
          for (const id of ids) {
            const m = /^users\/[^/]+\/dataTypes\/([a-z0-9-]+)\/dataPoints\/[^/]+$/.exec(id);
            if (!m) throw new UserInputError(`Not a data point id: ${id}`);
            const type = m[1];
            if (!writable.includes(type)) throw new UserInputError(`Entries of type ${type} can't be deleted`);
            requireScope(ctx, writeScope(getDataType(type)), type);
            byType.set(type, [...(byType.get(type) ?? []), normalizeName(id, type)]);
          }
          const deleted: Record<string, number> = {};
          for (const [type, names] of byType) {
            const op = await ctx.health.batchDelete(type, names);
            if (op.error) throw new Error(op.error.message ?? `Delete failed for ${type}`);
            deleted[type] = names.length;
          }
          return { deleted };
        }),
    );
  }

  if (can("settings.writeonly") || can("profile.writeonly")) {
    server.registerTool(
      "update_settings",
      {
        title: "Update unit settings",
        description:
          "Changes the user's Google Health unit preferences and/or manual stride lengths. Only passed fields change.",
        inputSchema: {
          weightUnit: z.enum(["kilograms", "pounds", "stone"]).optional(),
          distanceUnit: z.enum(["kilometers", "miles"]).optional(),
          heightUnit: z.enum(["centimeters", "inches"]).optional(),
          waterUnit: z.enum(["ml", "fl_oz", "cup"]).optional(),
          swimUnit: z.enum(["meters", "yards"]).optional(),
          temperatureUnit: z.enum(["celsius", "fahrenheit"]).optional(),
          glucoseUnit: z.enum(["mg_dl", "mmol_l"]).optional(),
          walkingStrideCm: z.number().min(20).max(250).optional(),
          runningStrideCm: z.number().min(20).max(350).optional(),
        },
        annotations: { ...WRITE, idempotentHint: true },
      },
      (a) =>
        runTool(async () => {
          const settingsEnums: [keyof typeof a, string, string][] = [
            ["weightUnit", "weightUnit", "WEIGHT_UNIT_"],
            ["distanceUnit", "distanceUnit", "DISTANCE_UNIT_"],
            ["heightUnit", "heightUnit", "HEIGHT_UNIT_"],
            ["waterUnit", "waterUnit", "WATER_UNIT_"],
            ["swimUnit", "swimUnit", "SWIM_UNIT_"],
            ["temperatureUnit", "temperatureUnit", "TEMPERATURE_UNIT_"],
            ["glucoseUnit", "glucoseUnit", "GLUCOSE_UNIT_"],
          ];
          const settings: Json = {};
          for (const [arg, field, prefix] of settingsEnums) {
            if (a[arg] !== undefined) settings[field] = prefix + String(a[arg]).toUpperCase();
          }
          const profile: Json = {};
          if (a.walkingStrideCm !== undefined) profile.userConfiguredWalkingStrideLengthMm = Math.round(a.walkingStrideCm * 10);
          if (a.runningStrideCm !== undefined) profile.userConfiguredRunningStrideLengthMm = Math.round(a.runningStrideCm * 10);
          if (!Object.keys(settings).length && !Object.keys(profile).length) throw new UserInputError("Nothing to update");

          const result: Json = {};
          if (Object.keys(settings).length) {
            requireScope(ctx, "settings.writeonly", "settings");
            await ctx.health.updateSettings(settings, Object.keys(settings));
            result.settings = settings;
          }
          if (Object.keys(profile).length) {
            requireScope(ctx, "profile.writeonly", "profile");
            await ctx.health.updateProfile(profile, Object.keys(profile));
            result.profile = profile;
          }
          return { updated: result };
        }),
    );
  }
}
