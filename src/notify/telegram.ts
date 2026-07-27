// Telegram notifier. Swap this module to change delivery channel (Slack,
// Discord, email) without touching the budget logic.

import type { Env } from "../env";

const API = "https://api.telegram.org";

export async function sendMessage(env: Env, chatId: string, text: string): Promise<void> {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    console.error("telegram sendMessage failed", res.status, await res.text());
  }
}
