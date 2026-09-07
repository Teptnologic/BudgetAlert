// Worker entry point. Three triggers:
//   email()     — bank alerts routed via Cloudflare Email Routing
//   fetch()     — Telegram webhook + generic inbound-email webhook + health
//   scheduled() — the cron jobs: weekly digest, plus period reports

import type { Env } from "./env";
import { handleEmail } from "./email/inbound";
import { handleFetch } from "./router";
import { weeklySummaryText } from "./service";
import { scheduledReportText } from "./nl/execute";
import { scheduledJob, jobWindow } from "./core/schedule";
import { getConfig } from "./store/d1";
import { sendMessage } from "./notify/telegram";

export default {
  async email(message: any, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await handleEmail(message, env);
    } catch (err) {
      console.error("email handler error:", err);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduled(controller?.cron, env).catch((err) => {
        console.error("scheduled handler error:", err);
      }),
    );
  },
};

// Several crons share this one entry point, so the firing expression decides
// which job runs. Anything unrecognized is the weekly digest, which is what
// this handler did before reports existed.
async function runScheduled(cron: string | undefined, env: Env): Promise<void> {
  const cfg = await getConfig(env);
  if (!cfg.group_chat_id) return; // nowhere to post

  const job = scheduledJob(cron);
  if (job === "weekly") {
    const text = await weeklySummaryText(env);
    if (text) await sendMessage(env, cfg.group_chat_id, text);
    return;
  }

  // These fire on the FIRST day of the new period, so the report covers the
  // period that just closed — offset 1. Offset 0 would report a quarter that is
  // a few hours old and always read as "you have spent nothing".
  //
  // No model call is involved, so scheduled reports work without an API key.
  const text = await scheduledReportText(env, jobWindow(job), 1);
  if (text) await sendMessage(env, cfg.group_chat_id, text);
}
