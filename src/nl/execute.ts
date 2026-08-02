// Orchestrates a batch of intents: answers reads, and stages writes behind a
// single confirmation. This is the only place that acts on a natural-language
// message; the model never gets near D1.

import type { Env } from "../env";
import { calendarFrom } from "../env";
import type { Intent } from "./schema";
import { isMutating, batchMutates } from "./schema";
import { planBatch, applyBatch, type StepOutcome } from "./plan";
import {
  isPeriod,
  periodStart,
  periodStartAt,
  periodEnd,
  periodLabel,
  daysAgo,
  type Period,
} from "../core/period";
import { formatMoney } from "../core/engine";
import { budgetStatusText } from "../service";
import {
  getConfig,
  listCategories,
  findCategory,
  recentTransactions,
  listBetween,
  sumSince,
  type TxnScope,
  type FullTxnRow,
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
  // Short + opaque: Telegram caps callback_data at 64 bytes, so the batch is
  // stored server-side and only this key travels in the button.
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/* ------------------------------------------------------------------- reads */

async function readReply(env: Env, intent: Intent): Promise<string> {
  const cfg = await getConfig(env);
  const cal = calendarFrom(env);

  switch (intent.action) {
    case "get_status": {
      if (!intent.category) return await budgetStatusText(env);
      const cat = await findCategory(env, intent.category);
      if (!cat) return `I don't have a budget called <b>${esc(intent.category)}</b> yet.`;
      const period: Period = isPeriod(cat.period) ? cat.period : "yearly";
      const start = periodStart(period, new Date(), cal);
      const spent = await sumSince(env, start.toISOString(), cat.id);
      const remaining = cat.amount - spent;
      return (
        `<b>${esc(cat.label)}</b> — ${periodLabel(period, start, cal)}\n` +
        `Spent: ${formatMoney(spent, cfg.currency)} of ${formatMoney(cat.amount, cfg.currency)}\n` +
        `Remaining: <b>${formatMoney(remaining, cfg.currency)}</b>`
      );
    }

    case "query_spend": {
      const days = intent.window === "year" ? 365 : intent.window === "month" ? 30 : 7;
      const since = daysAgo(days, new Date(), cal).toISOString();
      const cat = intent.category ? await findCategory(env, intent.category) : null;
      if (intent.category && !cat) {
        return `I don't have a budget called <b>${esc(intent.category)}</b> yet.`;
      }
      const spent = await sumSince(env, since, cat ? cat.id : null);
      const scope = cat ? esc(cat.label) : "your main budget";
      return `Last ${days} days on ${scope}: <b>${formatMoney(spent, cfg.currency)}</b>`;
    }

    case "list_transactions":
      return await listTransactions(env, intent, cfg.currency);

    default:
      return intent.reason || "I didn't follow that. Try /help for what I understand.";
  }
}

// Spending history. With a window it covers one whole calendar period (this
// week, last week, …); without one it falls back to the most recent N.
async function listTransactions(env: Env, intent: Intent, currency: string): Promise<string> {
  const cal = calendarFrom(env);
  const cats = await listCategories(env);
  const byId = new Map(cats.map((c) => [c.id, c.label]));

  // Resolve the scope first — asking for an envelope that doesn't exist should
  // say so rather than quietly showing the main budget instead.
  let scope: TxnScope = { kind: "main" };
  let scopeLabel = "main budget";
  if (intent.scope === "all") {
    scope = { kind: "all" };
    scopeLabel = "everything";
  } else if (intent.scope === "category") {
    const cat = cats.find((c) => c.name === intent.category);
    if (!cat) return `I don't have a budget called <b>${esc(intent.category)}</b> yet.`;
    scope = { kind: "category", id: cat.id };
    scopeLabel = cat.label;
  }

  let rows: FullTxnRow[];
  let heading: string;

  if (intent.window === "none") {
    const limit = intent.limit || 5;
    const all = await recentTransactions(env, 50);
    rows = all
      .filter((r) =>
        scope.kind === "all"
          ? true
          : scope.kind === "main"
            ? r.category_id === null
            : r.category_id === scope.id,
      )
      .slice(0, limit)
      .reverse(); // oldest first, so it reads as a chronology
    heading = `Last ${rows.length} on ${esc(scopeLabel)}`;
  } else {
    const period: Period =
      intent.window === "year" ? "yearly" : intent.window === "month" ? "monthly" : "weekly";
    const start = periodStartAt(period, intent.periodOffset, new Date(), cal);
    const end = periodEnd(period, start, cal);
    rows = await listBetween(env, start.toISOString(), end.toISOString(), scope);
    const when =
      intent.periodOffset === 0
        ? `this ${intent.window}`
        : intent.periodOffset === 1
          ? `last ${intent.window}`
          : periodLabel(period, start, cal);
    heading = `${esc(scopeLabel)} — ${when} (${periodLabel(period, start, cal)})`;
  }

  if (!rows.length) return `<b>${heading}</b>\nNothing recorded.`;

  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  // Dates are stored as UTC instants but must READ as local days, or a Saturday
  // evening in California prints as Sunday and contradicts the week it's in.
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: cal.timeZone,
    month: "2-digit",
    day: "2-digit",
  });
  const lines = rows.map((r) => {
    const day = dayFmt.format(new Date(r.occurred_at));
    const tag =
      scope.kind === "all" && r.category_id ? ` [${esc(byId.get(r.category_id) ?? "?")}]` : "";
    return `${day}  ${formatMoney(r.amount, currency)} — ${esc(r.merchant ?? "unknown")}${tag}`;
  });

  return (
    `<b>${heading}</b>\n` +
    `<code>${lines.join("\n")}</code>\n` +
    `<b>Total: ${formatMoney(total, currency)}</b> across ${rows.length} transaction${rows.length === 1 ? "" : "s"}`
  );
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
