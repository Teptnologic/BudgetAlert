// Orchestrates a batch of intents: answers reads, and stages writes behind a
// single confirmation. This is the only place that acts on a natural-language
// message; the model never gets near D1.

import type { Env } from "../env";
import { calendarFrom } from "../env";
import type { Intent, Window } from "./schema";
import { isMutating, batchMutates, normalizeIntent, normalizeBatch } from "./schema";
import { planBatch, applyBatch, chargeLine, type PlannedStep, type StepOutcome } from "./plan";
import { MAX_CANDIDATES } from "./resolve";
import {
  isPeriod,
  periodStart,
  periodStartAt,
  periodEnd,
  periodLabel,
  daysAgo,
  type Period,
  type Calendar,
} from "../core/period";
import { formatMoney, computeStatus } from "../core/engine";
import { budgetStatusText, progressBar } from "../service";
import {
  getConfig,
  listCategories,
  findCategory,
  listBetween,
  listRecent,
  sumScope,
  sumSince,
  MAX_ROWS,
  totalsByCategory,
  topMerchants,
  type TxnScope,
  type FullTxnRow,
  type ConfigRow,
} from "../store/d1";

export interface Reply {
  text: string;
  /**
   * Set when the reply is waiting on a tap. The batch travels in `payload` for
   * the caller to stash; minting the token that identifies it is the
   * transport's job, since only the transport knows what fits in a button.
   */
  stage?: Stage;
}

export interface Stage {
  /** JSON to store against the token — read back by parsePending(). */
  payload: string;
  /**
   * One button per label, answered by INDEX into this list. Absent for an
   * ordinary yes/no confirmation.
   */
  choices?: string[];
}

/**
 * A batch parked in pending_actions.
 *
 * `confirm` is staged and waiting on yes/no. `disambiguate` is waiting on which
 * of `candidates` (transaction ids) step `step` meant; answering pins the
 * chosen row onto that step and re-plans, which is what turns the answer into a
 * confirmation. The whole batch travels along either way, so a message with
 * several steps survives a question about one of them.
 */
export interface PendingBatch {
  kind: "confirm" | "disambiguate";
  actions: Intent[];
  step: number;
  candidates: number[];
}

// Never throws: a malformed or truncated row degrades to an empty confirm,
// which the caller reports as expired rather than acting on.
//
// Also accepts the bare `{actions: […]}` (and legacy single-intent) shapes,
// which is what rows staged before this existed look like.
export function parsePending(json: string): PendingBatch {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    // normalizeBatch never yields an empty list, so callers always have
    // something to report rather than an empty message.
    return { kind: "confirm", actions: normalizeBatch(null), step: 0, candidates: [] };
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const candidates = Array.isArray(o.candidates)
    ? o.candidates.map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  return {
    kind: o.kind === "disambiguate" ? "disambiguate" : "confirm",
    actions: normalizeBatch(raw),
    step: Math.max(0, Math.trunc(Number(o.step) || 0)),
    candidates,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A report/listing window as a budget period. 'none' and 'all' have no calendar
// meaning, so callers that can receive them decide what to do before calling this.
function windowPeriod(window: Intent["window"]): Period {
  if (window === "year") return "yearly";
  if (window === "quarter") return "quarterly";
  if (window === "month") return "monthly";
  return "weekly";
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
      const cat = intent.category ? await findCategory(env, intent.category) : null;
      if (intent.category && !cat) {
        return `I don't have a budget called <b>${esc(intent.category)}</b> yet.`;
      }
      const scope = cat ? esc(cat.label) : "your main budget";

      // All-time is its own query, not a very large day count: "how much have I
      // ever spent on gifts" has no start date, and answering it with a rolling
      // window would quietly drop everything older than that window.
      if (intent.window === "all") {
        const { n, total } = await sumScope(
          env,
          cat ? { kind: "category", id: cat.id } : { kind: "main" },
        );
        return (
          `All time on ${scope}: <b>${formatMoney(total, cfg.currency)}</b> ` +
          `across ${n} transaction${n === 1 ? "" : "s"}`
        );
      }

      const days =
        intent.window === "year"
          ? 365
          : intent.window === "quarter"
            ? 91
            : intent.window === "month"
              ? 30
              : 7;
      const since = daysAgo(days, new Date(), cal).toISOString();
      const spent = await sumSince(env, since, cat ? cat.id : null);
      return `Last ${days} days on ${scope}: <b>${formatMoney(spent, cfg.currency)}</b>`;
    }

    case "list_transactions":
      return await listTransactions(env, intent, cfg.currency);

    case "report":
      return (await buildReport(env, intent, cfg)).text;

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
  // Set when the listing was capped, so the total can still speak for the whole
  // history rather than for the rows that happened to fit.
  let capped: { n: number; total: number } | null = null;

  if (intent.window === "all") {
    // Everything, ever. The rows are capped to what a chat message can hold,
    // but the count and total below come from the unbounded query.
    const totals = await sumScope(env, scope);
    rows = (await listRecent(env, scope, MAX_ROWS)).reverse();
    if (totals.n > rows.length) capped = totals;
    heading = `${esc(scopeLabel)} — all time`;
  } else if (intent.window === "none") {
    const limit = intent.limit || 5;
    // Filtered in SQL. Taking the newest 50 overall and filtering afterwards
    // showed "Nothing recorded" for an envelope whose charges were simply older
    // than the account's 50 most recent.
    rows = (await listRecent(env, scope, limit)).reverse(); // oldest first, so it reads as a chronology
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

  const total = capped ? capped.total : rows.reduce((sum, r) => sum + r.amount, 0);
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

  const shown = capped
    ? `\n<i>Showing the ${rows.length} most recent.</i>`
    : "";
  const count = capped ? capped.n : rows.length;

  return (
    `<b>${heading}</b>\n` +
    `<code>${lines.join("\n")}</code>\n` +
    `<b>Total: ${formatMoney(total, currency)}</b> across ${count} transaction${count === 1 ? "" : "s"}` +
    shown
  );
}

// An aggregated report over one whole calendar period: how the main budget did,
// what each envelope did, and the biggest merchants.
//
// Deliberately NOT list_transactions. That prints every row, which is right for
// a week and unreadable for a quarter or a year in a chat message. This answers
// "how did Q3 go?" in a screenful regardless of how much was spent.
// `empty` is reported separately from the text so a scheduled report can stay
// silent on a quiet period instead of posting "Nothing recorded" to the group,
// while someone who explicitly asked still gets an answer.
interface Report {
  text: string;
  empty: boolean;
}

async function buildReport(env: Env, intent: Intent, cfg: ConfigRow): Promise<Report> {
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
  if (!grandN) return { text: `${heading}\nNothing recorded.`, empty: true };

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
  return { text: out.join("\n"), empty: false };
}

// A report for the cron path: the same one the /report command produces, but
// null when the period had no spending at all, so a quiet quarter posts nothing.
export async function scheduledReportText(
  env: Env,
  window: Window,
  periodOffset: number,
): Promise<string | null> {
  const cfg = await getConfig(env);
  const intent = normalizeIntent({ action: "report", window, period_offset: periodOffset });
  const report = await buildReport(env, intent, cfg);
  return report.empty ? null : report.text;
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

// Plan a batch and either answer it (reads only), ask which charge it meant, or
// stage it for confirmation.
export async function executeBatch(env: Env, intents: Intent[]): Promise<Reply> {
  if (!batchMutates(intents)) {
    return { text: await readReplies(env, intents) };
  }

  const steps = await planBatch(env, intents);

  // Carry every row the plan resolved into the copy that gets staged, so
  // approving acts on the charge the confirmation named. planBatch returns one
  // step per intent, in order, so the indexes line up.
  const staged = intents.map((intent, i) => {
    const id = steps[i]?.txnId ?? 0;
    return id ? { ...intent, txnId: id } : intent;
  });

  // "Which one did you mean?" is a question, not a refusal — but only worth
  // asking if the rest of the batch is sound, since a hard failure blocks it
  // regardless of how the question is answered.
  const hard = steps.filter((s) => !s.ok && !s.candidates?.length);
  const asking = hard.length ? -1 : steps.findIndex((s) => (s.candidates?.length ?? 0) > 0);
  if (asking >= 0) {
    const cfg = await getConfig(env);
    return askWhich(steps, staged, asking, cfg.currency, calendarFrom(env));
  }

  // Validate upfront: one broken step blocks the whole batch, so a partially
  // understood message never half-applies.
  // Show the parse on failure too. A rejected step is exactly when the user
  // needs to see how the message was read — "no amount given" is baffling when
  // they plainly gave one, and the fields say where it actually landed.
  if (hard.length) {
    const header =
      steps.length === 1
        ? "I couldn't do that:"
        : "I couldn't do all of that, so I haven't done any of it:";
    return { text: `${header}\n\n${describeSteps(steps, true)}` };
  }

  const header =
    steps.length === 1 ? "Confirm this?" : `Confirm these ${steps.length} changes?`;

  return {
    text: `${header}\n\n${describeSteps(steps, false)}`,
    stage: { payload: JSON.stringify({ kind: "confirm", actions: staged }) },
  };
}

// Every step, spelled out. `withOutcome` appends each step's verdict to its
// heading, which is what a rejection needs and a confirmation doesn't.
function describeSteps(steps: PlannedStep[], withOutcome: boolean): string {
  return steps
    .map((s, i) => {
      const heading = steps.length === 1 ? s.view.title : `${i + 1}. ${s.view.title}`;
      const title = withOutcome ? `<b>${esc(heading)}</b> — ${s.text}` : `<b>${esc(heading)}</b>`;
      return [title, ...fieldLines(s.view.fields)].join("\n");
    })
    .join("\n\n");
}

// Ask which charge one step meant, offering the rows it could not choose
// between. The whole batch is staged with the question, so answering resumes
// the original message rather than making the user retype it.
//
// One question at a time: answering re-plans from scratch, and if another step
// is still ambiguous the next question follows.
function askWhich(
  steps: PlannedStep[],
  staged: Intent[],
  index: number,
  currency: string,
  cal: Calendar,
): Reply {
  const step = steps[index];
  const candidates = (step.candidates ?? []).slice(0, MAX_CANDIDATES);
  const money = (n: number) => formatMoney(n, currency);
  const heading =
    steps.length === 1
      ? "Which charge did you mean?"
      : `Which charge did you mean? (step ${index + 1} of ${steps.length})`;

  return {
    text: `${heading}\n\n${describeSteps(steps, true)}`,
    stage: {
      payload: JSON.stringify({
        kind: "disambiguate",
        step: index,
        candidates: candidates.map((t) => t.id),
        actions: staged,
      }),
      // Telegram renders button text verbatim — plain, and short enough to read
      // on a phone.
      choices: candidates.map((t) => truncate(chargeLine(t, money, cal), 48)),
    },
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
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
