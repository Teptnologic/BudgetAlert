// Handles Telegram webhook updates for on-demand commands in the group.
//
//   /status  (or "left", "balance")  → remaining budget for the current period
//   /budget <amount>                 → set the budget amount
//   /setgroup                        → register this chat for alerts & summaries
//   /help                            → command list

import type { Env } from "../env";
import { setBudget, setGroupChat, getConfig } from "../store/d1";
import { budgetStatusText } from "../service";
import { sendMessage } from "../notify/telegram";
import { formatMoney } from "../core/engine";

interface TgUpdate {
  message?: {
    text?: string;
    chat?: { id: number | string };
  };
}

export async function handleTelegramUpdate(update: TgUpdate, env: Env): Promise<void> {
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text?.trim();
  if (chatId == null || !text) return;

  const chat = String(chatId);
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.replace(/@[\w_]+$/, "").toLowerCase(); // strip @botname suffix
  const arg = rest.join(" ");

  switch (cmd) {
    case "/status":
    case "status":
    case "left":
    case "balance":
      await sendMessage(env, chat, await budgetStatusText(env));
      return;

    case "/budget": {
      const amount = parseFloat(arg.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(amount) || amount <= 0) {
        await sendMessage(env, chat, "Usage: <code>/budget 500</code>");
        return;
      }
      await setBudget(env, amount);
      const cfg = await getConfig(env);
      await sendMessage(env, chat, `✅ Budget set to <b>${formatMoney(amount, cfg.currency)}</b>.`);
      return;
    }

    case "/setgroup":
      await setGroupChat(env, chat);
      await sendMessage(
        env,
        chat,
        "✅ This chat will now receive threshold alerts and the weekly summary.",
      );
      return;

    case "/help":
    case "/start":
      await sendMessage(
        env,
        chat,
        "<b>BudgetAlert</b>\n" +
          "/status — how much budget is left\n" +
          "/budget &lt;amount&gt; — set your budget\n" +
          "/setgroup — send alerts &amp; summaries here\n" +
          "/help — this message",
      );
      return;

    default:
      return; // ignore chatter
  }
}
