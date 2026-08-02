import type { Period, Calendar, WeekStart } from "./core/period";
import { DEFAULT_CALENDAR } from "./core/period";

// Bindings and vars available to the Worker. Secrets are injected at runtime
// via `wrangler secret put` (prod) or `.dev.vars` (local).
export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_USERNAME?: string;
  // Natural-language layer. Without a key the bot still works — slash commands
  // are unaffected and @mentions reply asking you to use them.
  ANTHROPIC_API_KEY?: string;
  NL_MODEL?: string;
  WARN_PCT?: string;
  ALERT_PCT?: string;
  CURRENCY?: string;
  BUDGET_PERIOD?: Period;
  /** IANA zone all budget periods are computed in, e.g. "America/Los_Angeles". */
  TIMEZONE?: string;
  /** "sunday" or "monday" — which day a budget week begins on. */
  WEEK_START?: string;
}

// Period boundaries depend on both of these, so every caller that has an Env
// should build the calendar from it rather than relying on the defaults.
export function calendarFrom(env: Env): Calendar {
  const weekStartsOn: WeekStart =
    (env.WEEK_START ?? "").trim().toLowerCase().startsWith("mon") ? 1 : 0;
  return {
    timeZone: env.TIMEZONE?.trim() || DEFAULT_CALENDAR.timeZone,
    weekStartsOn,
  };
}
