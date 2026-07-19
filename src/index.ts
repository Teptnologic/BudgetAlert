// Worker entry point. Three triggers:
//   email()     — bank alerts routed via Cloudflare Email Routing
//   fetch()     — Telegram webhook + generic inbound-email webhook + health
//   scheduled() — weekly summary cron

import type { Env } from "./env";
import { handleEmail } from "./email/inbound";
import { handleFetch } from "./router";
import { weeklySummaryText } from "./service";
import { getConfig } from "./store/d1";
import { sendMessage } from "./notify/telegram";

export default {
  async email(message: any, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, env);
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runWeeklySummary(env));
  },
};

async function runWeeklySummary(env: Env): Promise<void> {
  const cfg = await getConfig(env);
  if (!cfg.group_chat_id) return;
  const text = await weeklySummaryText(env);
  if (text) await sendMessage(env, cfg.group_chat_id, text);
}
