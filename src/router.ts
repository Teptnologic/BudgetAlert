// HTTP entry point. Routes:
//   GET  /            → health check
//   POST /telegram    → Telegram webhook (guarded by secret header)
//   POST /inbound     → generic inbound-email webhook (SendGrid/Mailgun/etc.),
//                       an alternative to Cloudflare Email Routing

import type { Env } from "./env";
import { handleTelegramUpdate } from "./telegram/commands";
import { parseTransaction } from "./core/parser";
import { recordAndEvaluate } from "./service";

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return new Response("BudgetAlert OK", { status: 200 });
  }

  if (request.method === "POST" && url.pathname === "/telegram") {
    // Verify Telegram's secret token so only Telegram can drive commands.
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const got = request.headers.get("x-telegram-bot-api-secret-token");
      if (got !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
    }
    const update = await request.json().catch(() => null);
    if (update) {
      try {
        await handleTelegramUpdate(update, env);
      } catch (err) {
        // Log for `wrangler tail` but still return 200, so Telegram doesn't
        // retry the same failing update forever.
        console.error("telegram handler error:", err);
      }
    }
    return new Response("ok", { status: 200 });
  }

  if (request.method === "POST" && url.pathname === "/inbound") {
    // Generic email webhook: accepts JSON { subject, text, date? }.
    const body = (await request.json().catch(() => null)) as
      | { subject?: string; text?: string; date?: string }
      | null;
    if (!body) return new Response("bad request", { status: 400 });
    try {
      const parsed = parseTransaction(body.subject ?? "", body.text ?? "");
      if (parsed) {
        const occurredAt = body.date ? new Date(body.date).toISOString() : new Date().toISOString();
        await recordAndEvaluate(env, parsed, occurredAt, "webhook");
      }
    } catch (err) {
      console.error("inbound webhook error:", err);
    }
    return new Response("ok", { status: 200 });
  }

  return new Response("not found", { status: 404 });
}
