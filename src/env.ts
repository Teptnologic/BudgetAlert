import type { Period } from "./core/period";

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
}
