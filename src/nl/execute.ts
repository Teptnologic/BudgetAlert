// Orchestrates a batch of intents: answers reads, and stages writes behind a
// single confirmation. This is the only place that acts on a natural-language
// message; the model never gets near D1.

import type { Env } from "../env";
import type { Intent } from "./schema";
import { isMutating, batchMutates } from "./schema";
import { planBatch, applyBatch, type StepOutcome } from "./plan";
import { isPeriod, periodStart, periodLabel, daysAgo, type Period } from "../core/period";
import { formatMoney } from "../core/engine";
import { budgetStatusText } from "../service";
import { getConfig, listCategories, findCategory, recentTransactions, sumSince } from "../store/d1";

export interface Reply {
  text: string;
  // When set, render Yes/No buttons carrying this token as callback_data.
  confirmToken?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function token(): string {
  // Short + opaque: Telegram caps callback_data at 64 bytes, so the batch is
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
      const period: Period = isPeriod(cat.period) ? cat.period : "yearly";
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

async function readReplies(env: Env, intents: Intent[]): Promise<string> {
  const out: string[] = [];
  for (const intent of intents) {
    if (!isMutating(intent.action)) out.push(await readReply(env, intent));
  }
  return out.join("\n\n");
}

/* ------------------------------------------------------------------ entry */

function numbered(items: string[]): string {
  return items.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

// Plan a batch and either answer it (reads only) or stage it for confirmation.
export async function executeBatch(env: Env, intents: Intent[]): Promise<Reply> {
  if (!batchMutates(intents)) {
    return { text: await readReplies(env, intents) };
  }

  const steps = await planBatch(env, intents);
  const bad = steps.filter((s) => !s.ok);

  // Validate upfront: one broken step blocks the whole batch, so a partially
  // understood message never half-applies.
  // Show the parse on failure too. A rejected step is exactly when the user
  // needs to see how the message was read — "no amount given" is baffling when
  // they plainly gave one, and the fields say where it actually landed.
  if (bad.length) {
    const header =
      steps.length === 1
        ? "I couldn't do that:"
        : "I couldn't do all of that, so I haven't done any of it:";
    const blocks = steps.map((s, i) => {
      const heading = steps.length === 1 ? s.view.title : `${i + 1}. ${s.view.title}`;
      return [
        `<b>${esc(heading)}</b> — ${s.text}`,
        ...fieldLines(s.view.fields),
      ].join("\n");
    });
    return { text: `${header}\n\n${blocks.join("\n\n")}` };
  }

  const blocks = steps.map((s, i) => {
    const heading = steps.length === 1 ? s.view.title : `${i + 1}. ${s.view.title}`;
    return [`<b>${esc(heading)}</b>`, ...fieldLines(s.view.fields)].join("\n");
  });

  const header =
    steps.length === 1 ? "Confirm this?" : `Confirm these ${steps.length} changes?`;

  return { text: `${header}\n\n${blocks.join("\n\n")}`, confirmToken: token() };
}

// The parse, spelled out. A one-line summary can read plausibly while a single
// field is quietly wrong — showing every field is what makes that visible.
// Labels are padded into a monospace column so values line up.
function fieldLines(fields: [string, string][]): string[] {
  const width = Math.max(...fields.map(([label]) => label.length), 0);
  return fields.map(
    ([label, value]) => `<code>${esc(label.padEnd(width))}</code>  ${esc(value)}`,
  );
}

// Run an approved batch: writes first, then reads so their answers reflect the
// new state.
export async function applyApproved(env: Env, intents: Intent[]): Promise<string> {
  const outcomes: StepOutcome[] = await applyBatch(env, intents);
  const failed = outcomes.filter((o) => !o.ok).length;

  let out: string;
  if (outcomes.length === 1) {
    out = `${outcomes[0].ok ? "✅" : "❌"} ${outcomes[0].text}.`;
  } else {
    const lines = outcomes.map((o) => `${o.ok ? "✅" : "❌"} ${o.text}`);
    out = numbered(lines);
    if (failed) {
      out += `\n\n⚠️ ${failed} of ${outcomes.length} steps didn't apply — the rest did.`;
    }
  }

  const reads = await readReplies(env, intents);
  if (reads) out += `\n\n${reads}`;

  // Anything that shifts spend or the limit changes what's left, so show it.
  const changesRemaining: Intent["action"][] = [
    "add_transaction",
    "move_transaction",
    "set_transaction_amount",
    "set_budget",
  ];
  if (intents.some((i) => changesRemaining.includes(i.action))) {
    out += `\n\n${await budgetStatusText(env)}`;
  }
  return out;
}
