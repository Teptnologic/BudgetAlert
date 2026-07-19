import type { Period } from "./core/period";

// Bindings and vars available to the Worker. Secrets are injected at runtime
// via `wrangler secret put` (prod) or `.dev.vars` (local).
export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  WARN_PCT?: string;
  ALERT_PCT?: string;
  CURRENCY?: string;
  BUDGET_PERIOD?: Period;
}
