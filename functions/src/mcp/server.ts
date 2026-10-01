import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { registerGoalTools } from "./tools/goals.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

export const SERVER_INFO = { name: "google-health-mcp", version: "0.1.0" };

const INSTRUCTIONS = `Google Health MCP: the user's health and fitness data from Google Health — Fitbit and Pixel Watch devices, manual entries, and data synced from Apple Health and Health Connect.

- Call get_user_context first to learn today's date, timezone, preferred units, granted permissions and goals.
- Dates are YYYY-MM-DD in the user's timezone. Outputs use metric units (kg, km, kcal, g, ml, minutes); convert to the user's preferred units in your replies.
- For analysis prefer get_daily_summaries and get_goal_progress; use get_metric_series for intraday detail and list_data_points for raw entries.
- Goals (calorie/macro targets, weight target, step goal, coaching plan) are stored by this server via set_goals; the Google Health app won't show them.
- Confirm with the user before logging, changing settings, saving goals or deleting entries, unless they explicitly asked for that action.
- You are not a medical provider. Point out concerning values (e.g. very low intake, abnormal resting heart rate) and recommend professional advice; avoid diagnoses.`;

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerReadTools(server, ctx);
  registerGoalTools(server, ctx);
  registerWriteTools(server, ctx);
  registerPrompts(server);
  return server;
}

function registerPrompts(server: McpServer) {
  const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

  server.registerPrompt(
    "weekly_review",
    {
      title: "Weekly health review",
      description: "Review the last week against goals and suggest focus areas for the next one",
      argsSchema: { focus: z.string().optional().describe("Optional focus, e.g. 'sleep' or 'fat loss'") },
    },
    ({ focus }) =>
      user(
        `Do my weekly health check-in${focus ? ` with a focus on ${focus}` : ""}.
1. Call get_user_context, then get_goal_progress with days=7 and get_daily_summaries for the last 28 days.
2. Summarize the week: activity, workouts, sleep, recovery (resting HR, HRV), nutrition vs targets, and the weight trend (use the smoothed trend, not single weigh-ins).
3. Compare with the previous three weeks and call out what improved or slipped, with numbers.
4. Recommend 2–3 specific, realistic changes for next week. If I have no goals yet, propose some and ask before saving them with set_goals.`,
      ),
  );

  server.registerPrompt(
    "fat_loss_plan",
    {
      title: "Fat loss plan",
      description: "Build a calorie, protein and activity plan from real expenditure data",
      argsSchema: {
        targetWeightKg: z.string().optional().describe("Goal weight in kg"),
        targetDate: z.string().optional().describe("Goal date, YYYY-MM-DD"),
      },
    },
    ({ targetWeightKg, targetDate }) =>
      user(
        `Help me plan sustainable fat loss${targetWeightKg ? ` to ${targetWeightKg} kg` : ""}${targetDate ? ` by ${targetDate}` : ""}.
1. Call get_user_context and get_daily_summaries for the last 28 days (plus get_goal_progress for the weight trend).
2. Estimate my maintenance calories from measured total calories burned, cross-checked against logged intake and the weight trend where logging is complete. State your assumptions.
3. Propose a daily calorie target (a deficit of roughly 0.5–1% of body weight per week, never below safe minimums), a protein target (about 1.6–2.2 g per kg of goal weight), fat/carb split, step and Active Zone Minutes targets, and strength training frequency.
4. Show the projected timeline. Ask me to confirm, then save it with set_goals (including startWeightKg, startDate and a short coachingPlan).`,
      ),
  );

  server.registerPrompt(
    "log_food",
    {
      title: "Log food from a description",
      description: "Estimate nutrition for a described meal and log it",
      argsSchema: { description: z.string().describe("What you ate, e.g. '2 eggs, toast with butter, latte'") },
    },
    ({ description }) =>
      user(
        `I ate: ${description}
Estimate calories, protein, carbs, fat and fiber for each item (state portion assumptions), show a short table with totals, and ask me to confirm or correct. After I confirm, log each item with log_meal using a sensible mealType for the time of day, then show how today's totals compare with my goals (get_goal_progress).`,
      ),
  );
}
