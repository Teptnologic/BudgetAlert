// Telegram notifier. Swap this module to change delivery channel (Slack,
// Discord, email) without touching the budget logic.

import type { Env } from "../env";

const API = "https://api.telegram.org";

export async function sendMessage(
  env: Env,
  chatId: string,
  text: string,
  confirmToken?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (confirmToken) {
    body.reply_markup = {
      inline_keyboard: [
        [
          { text: "✅ Yes", callback_data: `y:${confirmToken}` },
          { text: "✖️ No", callback_data: `n:${confirmToken}` },
        ],
      ],
    };
  }
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("telegram sendMessage failed", res.status, await res.text());
  }
}

// Acknowledge a button tap so Telegram stops showing the client-side spinner.
export async function answerCallback(env: Env, callbackId: string, text = ""): Promise<void> {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
  if (!res.ok) {
    console.error("telegram answerCallbackQuery failed", res.status, await res.text());
  }
}

// Replace the confirmation prompt with the outcome, and drop its buttons so the
// same action can't be tapped again.
export async function editMessage(
  env: Env,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [] },
    }),
  });
  if (!res.ok) {
    console.error("telegram editMessageText failed", res.status, await res.text());
  }
}
