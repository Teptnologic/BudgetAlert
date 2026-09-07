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
import { formatMoney, computeStatus } from "../core/engine";
import { budgetStatusText, progressBar } from "../service";
import {
  getConfig,
  listCategories,
  findCategory,
  recentTransactions,
  listBetween,
  sumSince,
  totalsByCategory,
  topMerchants,
  type TxnScope,
  type FullTxnRow,
  type ConfigRow,
} from "../store/d1";

export interface Reply {
  text: string;
  // When set, render Yes/No buttons carrying this token as callback_data.
  confirmToken?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A report/listing window as a budget period. 'none' has no calendar meaning,
// so callers that can receive it decide what to do before calling this.
function windowPeriod(window: Intent["window"]): Period {
  if (window === "year") return "yearly";
  if (window === "quarter") return "quarterly";
  if (window === "month") return "monthly";
  return "weekly";
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
      const days =
        intent.window === "year"
          ? 365
          : intent.window === "quarter"
            ? 91
            : intent.window === "month"
              ? 30
              : 7;
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

    case "report":
      return await reportText(env, intent, cfg);

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
    const period = windowPeriod(intent.window);
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

// An aggregated report over one whole calendar period: how the main budget did,
// what each envelope did, and the biggest merchants.
//
// Deliberately NOT list_transactions. That prints every row, which is right for
// a week and unreadable for a quarter or a year in a chat message. This answers
// "how did Q3 go?" in a screenful regardless of how much was spent.
async function reportText(env: Env, intent: Intent, cfg: ConfigRow): Promise<string> {
  const cal = calendarFrom(env);
  const period = windowPeriod(intent.window);
  const start = periodStartAt(period, intent.periodOffset, new Date(), cal);
  const end = periodEnd(period, start, cal);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const [totals, top, cats] = await Promise.all([
    totalsByCategory(env, startIso, endIso),
    topMerchants(env, startIso, endIso, 5),
    listCategories(env),
  ]);

  const money = (n: number) => formatMoney(n, cfg.currency);
  const label = periodLabel(period, start, cal);
  const heading = `📊 <b>${esc(label)}</b>${intent.periodOffset === 0 ? " so far" : ""}`;

  const main = totals.find((t) => t.category_id === null) ?? { n: 0, total: 0 };
  const grand = totals.reduce((sum, t) => sum + t.total, 0);
  const grandN = totals.reduce((sum, t) => sum + t.n, 0);
  if (!grandN) return `${heading}\nNothing recorded.`;

  const out: string[] = [heading, ""];

  // The budget line only means something when the report covers the same
  // cadence the budget resets on — "$1,240 of $500" for a quarter on a weekly
  // budget would read as a catastrophic overspend rather than 13 weeks of them.
  const txns = (n: number) => `${n} transaction${n === 1 ? "" : "s"}`;
  if (cfg.budget_amount > 0 && cfg.period === period) {
    const status = computeStatus(cfg.budget_amount, main.total, cfg.currency);
    out.push(
      "<b>Main budget</b>",
      `${progressBar(status.pct)} ${status.pct.toFixed(0)}%`,
      `Spent: ${money(status.spent)} of ${money(status.budget)} across ${txns(main.n)}`,
      `Remaining: <b>${money(status.remaining)}</b>`,
    );
  } else {
    out.push("<b>Main budget</b>", `Spent: <b>${money(main.total)}</b> across ${txns(main.n)}`);
    if (cfg.budget_amount > 0) {
      out.push(
        `<i>Your budget resets ${esc(cfg.period)}, so there's no single limit to compare a ` +
          `${esc(reportWord(period))} against.</i>`,
      );
    }
  }

  if (cats.length) {
    const byId = new Map(totals.filter((t) => t.category_id !== null).map((t) => [t.category_id, t]));
    const lines = cats.map((c) => {
      const t = byId.get(c.id) ?? { n: 0, total: 0 };
      // Show the envelope's own limit only when it resets on the same cadence
      // the report covers, for the same reason the main budget line does.
      const of = c.period === period ? ` of ${money(c.amount)}` : "";
      return `• ${esc(c.label)}: ${money(t.total)}${of} across ${txns(t.n)}`;
    });
    out.push("", "<b>Envelopes</b>", ...lines);
  }

  if (top.length) {
    out.push(
      "",
      "<b>Biggest merchants</b>",
      ...top.map(
        (m) => `• ${money(m.total)} — ${esc(m.merchant ?? "unknown")}${m.n > 1 ? ` (${m.n}×)` : ""}`,
      ),
    );
  }

  out.push("", `<b>Everything together: ${money(grand)}</b> across ${txns(grandN)}`);
  return out.join("\n");
}

function reportWord(period: Period): string {
  return period === "yearly"
    ? "year"
    : period === "quarterly"
      ? "quarter"
      : period === "monthly"
        ? "month"
        : "week";
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
    "remove_transaction",
    "unfile_transaction",
    "delete_category",
    "set_budget",
  ];
  if (intents.some((i) => changesRemaining.includes(i.action))) {
    out += `\n\n${await budgetStatusText(env)}`;
  }
  return out;
}
