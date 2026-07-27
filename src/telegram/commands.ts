// Handles Telegram webhook updates.
//
// Two paths:
//   /command …          → fast, deterministic, no API call
//   @bot <plain text>   → natural-language intent via the Claude API
//
//   /status  (or "left", "balance")  → remaining budget for the current period
//   /budget <amount>                 → set the budget amount
//   /period weekly|monthly|yearly    → set the budget window
//   /categories                      → list budget envelopes
//   /setgroup                        → register this chat for alerts & summaries
//   /help                            → command list

import type { Env } from "../env";
import {
  setBudget,
  setGroupChat,
  setPeriod,
  getConfig,
  listCategories,
  recentTransactions,
  savePending,
  takePending,
  sumSince,
} from "../store/d1";
import { budgetStatusText } from "../service";
import { sendMessage, answerCallback, editMessage } from "../notify/telegram";
import { formatMoney } from "../core/engine";
import { isPeriod, periodStart } from "../core/period";
import { interpret } from "../nl/interpret";
import { execute, applyMutation } from "../nl/execute";
import { normalizeIntent } from "../nl/schema";

interface TgUpdate {
  message?: {
    text?: string;
    chat?: { id: number | string };
    reply_to_message?: { from?: { is_bot?: boolean } };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat?: { id: number | string } };
  };
}

export async function handleTelegramUpdate(update: TgUpdate, env: Env): Promise<void> {
  if (update.callback_query) return handleCallback(update, env);

  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text?.trim();
  if (chatId == null || !text) return;

  const chat = String(chatId);

  if (text.startsWith("/")) return handleCommand(env, chat, text);

  // Bare status aliases, kept from before the NL layer existed.
  const bare = text.toLowerCase();
  if (bare === "status" || bare === "left" || bare === "balance") {
    await sendMessage(env, chat, await budgetStatusText(env));
    return;
  }

  // Natural language only when the bot is addressed — either @mentioned or
  // replied to. Everything else in the group is ignored, as before.
  const mentioned = stripMention(text, env.TELEGRAM_BOT_USERNAME);
  const repliedTo = msg?.reply_to_message?.from?.is_bot === true;
  if (mentioned === null && !repliedTo) return;

  await handleNaturalLanguage(env, chat, mentioned ?? text);
}

// Returns the message with the @mention removed, or null if not mentioned.
function stripMention(text: string, botUsername?: string): string | null {
  if (!botUsername) return null;
  const handle = botUsername.replace(/^@/, "");
  const re = new RegExp(`@${handle}\\b`, "i");
  if (!re.test(text)) return null;
  return text.replace(re, " ").replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------- natural language */

async function handleNaturalLanguage(env: Env, chat: string, text: string): Promise<void> {
  if (!text) {
    await sendMessage(env, chat, 'Yes? Ask me something like "how much is left this week?"');
    return;
  }

  const [cfg, categories, recent] = await Promise.all([
    getConfig(env),
    listCategories(env),
    recentTransactions(env, 10),
  ]);

  const intent = await interpret(env, text, {
    currency: cfg.currency,
    categories: categories.map((c) => ({
      name: c.name,
      label: c.label,
      amount: c.amount,
      period: c.period,
    })),
    recent: recent.map((r) => ({
      amount: r.amount,
      merchant: r.merchant,
      occurredAt: r.occurred_at,
    })),
  });

  const reply = await execute(env, intent);

  if (reply.confirmToken) {
    await savePending(env, reply.confirmToken, chat, JSON.stringify(intent), reply.text);
  }
  await sendMessage(env, chat, reply.text, reply.confirmToken);
}

async function handleCallback(update: TgUpdate, env: Env): Promise<void> {
  const cb = update.callback_query!;
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const data = cb.data ?? "";
  if (chatId == null || messageId == null) {
    await answerCallback(env, cb.id);
    return;
  }
  const chat = String(chatId);
  const [verdict, tok] = data.split(":");

  if (verdict === "n") {
    await takePending(env, tok ?? "");
    await answerCallback(env, cb.id, "Cancelled");
    await editMessage(env, chat, messageId, "✖️ Cancelled — nothing changed.");
    return;
  }

  if (verdict !== "y" || !tok) {
    await answerCallback(env, cb.id);
    return;
  }

  // takePending deletes as it reads, so a double-tap finds nothing.
  const pending = await takePending(env, tok);
  if (!pending) {
    await answerCallback(env, cb.id, "That request expired");
    await editMessage(env, chat, messageId, "⏰ That request expired — ask me again.");
    return;
  }

  await answerCallback(env, cb.id, "Working…");
  try {
    const intent = normalizeIntent(JSON.parse(pending.intent));
    const result = await applyMutation(env, intent);
    await editMessage(env, chat, messageId, result);
  } catch (err) {
    console.error("callback apply error:", err);
    await editMessage(env, chat, messageId, "⚠️ That didn't go through. Try again.");
  }
}

/* --------------------------------------------------------------- commands */

async function handleCommand(env: Env, chat: string, text: string): Promise<void> {
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.replace(/@[\w_]+$/, "").toLowerCase(); // strip @botname suffix
  const arg = rest.join(" ");

  switch (cmd) {
    case "/status":
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

    case "/period": {
      const p = arg.toLowerCase();
      const period = p.startsWith("week")
        ? "weekly"
        : p.startsWith("month")
          ? "monthly"
          : p.startsWith("year")
            ? "yearly"
            : null;
      if (!period) {
        await sendMessage(
          env,
          chat,
          "Usage: <code>/period weekly</code>, <code>monthly</code>, or <code>yearly</code>",
        );
        return;
      }
      await setPeriod(env, period);
      await sendMessage(env, chat, `✅ Budget period set to <b>${period}</b>.`);
      return;
    }

    case "/categories": {
      const cfg = await getConfig(env);
      const cats = await listCategories(env);
      if (!cats.length) {
        await sendMessage(
          env,
          chat,
          "No budget envelopes yet. Try: <i>@bot create a yearly gift budget of 1200</i>",
        );
        return;
      }
      const lines: string[] = [];
      for (const c of cats) {
        const period = isPeriod(c.period) ? c.period : "yearly";
        const spent = await sumSince(env, periodStart(period).toISOString(), c.id);
        lines.push(
          `• <b>${c.label}</b> — ${formatMoney(spent, cfg.currency)} of ` +
            `${formatMoney(c.amount, cfg.currency)} per ${period}`,
        );
      }
      await sendMessage(env, chat, `<b>Budget envelopes</b>\n${lines.join("\n")}`);
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
          "/budget &lt;amount&gt; — set your main budget\n" +
          "/period weekly|monthly|yearly — set the budget window\n" +
          "/categories — list budget envelopes\n" +
          "/setgroup — send alerts &amp; summaries here\n" +
          "/help — this message\n\n" +
          "<b>Or just @ me:</b>\n" +
          "<i>@bot move the last $200 charge into yearly gift budget</i>\n" +
          "<i>@bot create a yearly gift budget of 1200</i>\n" +
          "<i>@bot how much did I spend on gifts this year?</i>",
      );
      return;

    default:
      return; // ignore chatter
  }
}
