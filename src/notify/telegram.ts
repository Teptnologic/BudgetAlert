// Telegram notifier. Swap this module to change delivery channel (Slack,
// Discord, email) without touching the budget logic.

import type { Env } from "../env";

const API = "https://api.telegram.org";

/** One inline button: a label the user reads, and the answer it sends back. */
export interface Button {
  text: string;
  data: string;
}

/** Rows of inline buttons, rendered under a message. */
export type Keyboard = Button[][];

// Callback data is capped at 64 bytes, so it carries a token and nothing else;
// the batch it stands for lives in pending_actions.
export function confirmKeyboard(token: string): Keyboard {
  return [
    [
      { text: "✅ Yes", data: `y:${token}` },
      { text: "✖️ No", data: `n:${token}` },
    ],
  ];
}

// "Which one did you mean?" — one row per candidate, answered by index, plus a
// way out for when the answer is none of them.
export function chooseKeyboard(token: string, labels: string[]): Keyboard {
  return [
    ...labels.map((text, i) => [{ text: `${i + 1}. ${text}`, data: `d:${token}:${i}` }]),
    [{ text: "✖️ None of these", data: `n:${token}` }],
  ];
}

function markup(keyboard: Keyboard): Record<string, unknown> {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((b) => ({ text: b.text, callback_data: b.data })),
    ),
  };
}

export async function sendMessage(
  env: Env,
  chatId: string,
  text: string,
  keyboard?: Keyboard,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (keyboard?.length) body.reply_markup = markup(keyboard);
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

// Replace a prompt with what came of it. Buttons are dropped unless the reply
// asks another question — answering "which charge?" leads to the confirmation
// for that charge, in the same message.
export async function editMessage(
  env: Env,
  chatId: string,
  messageId: number,
  text: string,
  keyboard?: Keyboard,
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
      reply_markup: keyboard?.length ? markup(keyboard) : { inline_keyboard: [] },
    }),
  });
  if (!res.ok) {
    console.error("telegram editMessageText failed", res.status, await res.text());
  }
}
