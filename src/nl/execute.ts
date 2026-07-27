// Maps a normalized Intent onto typed handlers. This is the only place that
// writes data on behalf of a natural-language message; the model never gets
// near D1. Read intents answer immediately, mutating intents are staged behind
// a Yes/No confirmation.

import type { Env } from "../env";
import type { Intent } from "./schema";
import { isMutating } from "./schema";
import { isPeriod, periodStart, periodLabel, daysAgo, type Period } from "../core/period";
import { formatMoney } from "../core/engine";
import { budgetStatusText } from "../service";
import {
  getConfig,
  setBudget,
  setPeriod,
  listCategories,
  findCategory,
  upsertCategory,
  setCategoryBudget,
  recentTransactions,
  findTransaction,
  setTxnCategory,
  sumSince,
} from "../store/d1";

export interface Reply {
  text: string;
  // When set, render Yes/No buttons carrying this token as callback_data.
  confirmToken?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function token(): string {
  // Short + opaque: Telegram caps callback_data at 64 bytes, so the intent is
  // stored server-side and only this key travels in the button.
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/* ------------------------------------------------------------------- reads */

async function readReply(env: Env, intent: Intent): Promise<string> {
  const cfg = await getConfig(env);

  switch (intent.action) {
    case "get_status": {
      if (!intent.category) return await budgetStatusText(env);
      const cat = await findCategory(env, intent.category);
      if (!cat) return `I don't have a budget called <b>${esc(intent.category)}</b> yet.`;
      const period = isPeriod(cat.period) ? cat.period : "yearly";
      const start = periodStart(period);
      const spent = await sumSince(env, start.toISOString(), cat.id);
      const remaining = cat.amount - spent;
      return (
        `<b>${esc(cat.label)}</b> — ${periodLabel(period, start)}\n` +
        `Spent: ${formatMoney(spent, cfg.currency)} of ${formatMoney(cat.amount, cfg.currency)}\n` +
        `Remaining: <b>${formatMoney(remaining, cfg.currency)}</b>`
      );
    }

    case "query_spend": {
      const days = intent.window === "year" ? 365 : intent.window === "month" ? 30 : 7;
      const since = daysAgo(days).toISOString();
      const cat = intent.category ? await findCategory(env, intent.category) : null;
      if (intent.category && !cat) {
        return `I don't have a budget called <b>${esc(intent.category)}</b> yet.`;
      }
      const spent = await sumSince(env, since, cat ? cat.id : null);
      const scope = cat ? esc(cat.label) : "your main budget";
      return `Last ${days} days on ${scope}: <b>${formatMoney(spent, cfg.currency)}</b>`;
    }

    case "list_recent": {
      const rows = await recentTransactions(env, intent.limit || 5);
      if (!rows.length) return "No transactions recorded yet.";
      const cats = await listCategories(env);
      const byId = new Map(cats.map((c) => [c.id, c.label]));
      const lines = rows.map((r) => {
        const where = r.category_id ? ` [${esc(byId.get(r.category_id) ?? "?")}]` : "";
        return `• ${formatMoney(r.amount, cfg.currency)} — ${esc(r.merchant ?? "unknown")}${where}`;
      });
      return `<b>Recent transactions</b>\n${lines.join("\n")}`;
    }

    default:
      return intent.reason || "I didn't follow that. Try /help for what I understand.";
  }
}

/* ------------------------------------------------- mutations: summarize first */

// Render what the action WOULD do, so the user confirms against real values
// (resolved merchant, resolved category) rather than against their own phrasing.
async function describeMutation(env: Env, intent: Intent): Promise<string | null> {
  const cfg = await getConfig(env);

  switch (intent.action) {
    case "move_transaction": {
      if (intent.selectorKind === "none") return null;
      const value = intent.selectorKind === "amount" ? intent.amount : intent.selectorValue;
      const txn = await findTransaction(env, intent.selectorKind, value);
      if (!txn) return null;
      if (!intent.category) return null;
      const cat = await findCategory(env, intent.category);
      if (!cat) {
        return (
          `I don't have a budget called <b>${esc(intent.category)}</b> yet. ` +
          `Create it first, e.g. "create a yearly ${esc(intent.category)} budget of 1200".`
        );
      }
      return (
        `Move ${formatMoney(txn.amount, cfg.currency)} — ` +
        `${esc(txn.merchant ?? "unknown")} → <b>${esc(cat.label)}</b>?`
      );
    }

    case "set_budget": {
      if (intent.amount <= 0) return null;
      if (intent.category) {
        const cat = await findCategory(env, intent.category);
        if (!cat) return null;
        return `Set <b>${esc(cat.label)}</b> budget to ${formatMoney(intent.amount, cfg.currency)}?`;
      }
      return `Set your main budget to ${formatMoney(intent.amount, cfg.currency)}?`;
    }

    case "create_category": {
      if (!intent.category) return null;
      const period = intent.period === "none" ? "yearly" : intent.period;
      const label = intent.categoryLabel || intent.category;
      return (
        `Create budget <b>${esc(label)}</b> — ` +
        `${formatMoney(intent.amount, cfg.currency)} per ${period}?`
      );
    }

    case "set_period":
      if (intent.period === "none") return null;
      return `Set your main budget window to <b>${intent.period}</b>?`;

    default:
      return null;
  }
}

// Apply a previously-confirmed mutation. Re-resolves everything from the intent
// rather than trusting anything cached at describe time.
export async function applyMutation(env: Env, intent: Intent): Promise<string> {
  const cfg = await getConfig(env);

  switch (intent.action) {
    case "move_transaction": {
      if (intent.selectorKind === "none" || !intent.category) return "That move is no longer valid.";
      const value = intent.selectorKind === "amount" ? intent.amount : intent.selectorValue;
      const txn = await findTransaction(env, intent.selectorKind, value);
      const cat = await findCategory(env, intent.category);
      if (!txn || !cat) return "That move is no longer valid.";
      await setTxnCategory(env, txn.id, cat.id);
      return (
        `✅ Moved ${formatMoney(txn.amount, cfg.currency)} — ` +
        `${esc(txn.merchant ?? "unknown")} → <b>${esc(cat.label)}</b>.\n\n` +
        (await budgetStatusText(env))
      );
    }

    case "set_budget": {
      if (intent.category) {
        const cat = await findCategory(env, intent.category);
        if (!cat) return "That budget no longer exists.";
        await setCategoryBudget(env, cat.id, intent.amount);
        return `✅ <b>${esc(cat.label)}</b> budget set to ${formatMoney(intent.amount, cfg.currency)}.`;
      }
      await setBudget(env, intent.amount);
      return `✅ Main budget set to <b>${formatMoney(intent.amount, cfg.currency)}</b>.`;
    }

    case "create_category": {
      const period = intent.period === "none" ? "yearly" : intent.period;
      const label = intent.categoryLabel || intent.category;
      await upsertCategory(env, intent.category, label, intent.amount, period);
      return (
        `✅ Created <b>${esc(label)}</b> — ` +
        `${formatMoney(intent.amount, cfg.currency)} per ${period}.`
      );
    }

    case "set_period": {
      if (intent.period === "none") return "That change is no longer valid.";
      await setPeriod(env, intent.period as Period);
      return `✅ Budget window set to <b>${intent.period}</b>.`;
    }

    default:
      return "Nothing to do.";
  }
}

/* ------------------------------------------------------------------ entry */

export async function execute(env: Env, intent: Intent): Promise<Reply> {
  if (!isMutating(intent.action)) {
    return { text: await readReply(env, intent) };
  }

  const summary = await describeMutation(env, intent);
  if (!summary) {
    return {
      text: "I understood roughly what you meant but couldn't pin down the details. Try naming the amount and the budget explicitly.",
    };
  }
  // describeMutation returns guidance (not a question) when it wants to bail out
  // early — e.g. the target category doesn't exist yet. Nothing to confirm.
  if (!summary.endsWith("?")) return { text: summary };

  const t = token();
  return { text: summary, confirmToken: t };
}
