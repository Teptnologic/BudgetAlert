// Two-phase execution for a batch of intents.
//
//   planBatch()  — dry run. Validates every step against a PROJECTION of what
//                  earlier steps will have done, without writing anything.
//   applyBatch() — sequential execution of an approved plan.
//
// The projection is what makes dependent steps work. In "create a yearly gift
// budget and move the last $200 into it", step 2 has to validate against a world
// where step 1 already ran — but at planning time step 1 hasn't touched D1. So
// planning reads the projection, and each step updates it before the next is
// considered.

import type { Env } from "../env";
import { calendarFrom } from "../env";
import type { Intent } from "./schema";
import { isMutating } from "./schema";
import { isPeriod, daysAgo, type Period, type Calendar } from "../core/period";
import { formatMoney } from "../core/engine";
import {
  getConfig,
  listCategories,
  findCategory,
  findTransaction,
  upsertCategory,
  addManualTransaction,
  setCategoryBudget,
  setTxnCategory,
  setTxnAmount,
  deleteTransaction,
  deleteCategory,
  categoryTotals,
  setBudget,
  setPeriod,
} from "../store/d1";

export interface PlannedStep {
  ok: boolean;
  /** What this step will do, or why it can't. */
  text: string;
  /** The parsed intent, shown so a misparse is visible before approval. */
  view: IntentView;
}

// What planStep returns before the view is attached. `resolved` carries fields
// that only exist once the step has been checked against live data — which row
// a selector actually landed on, say — and they are appended to the view.
interface StepPlan {
  ok: boolean;
  text: string;
  /** Raw text, not HTML: fieldLines() in execute.ts escapes these. */
  resolved?: [label: string, value: string][];
}

// How the intent is shown back to the user before they approve it. This is the
// check on the model: the one-line summary can read plausibly while a single
// field is quietly wrong, so the confirmation spells the parse out in full.
export interface IntentView {
  title: string;
  fields: [label: string, value: string][];
}

const TITLES: Record<string, string> = {
  add_transaction: "Add transaction",
  move_transaction: "Move transaction",
  set_transaction_amount: "Correct amount",
  remove_transaction: "Remove transaction",
  unfile_transaction: "Return to main budget",
  set_budget: "Set budget",
  create_category: "New budget envelope",
  delete_category: "Delete budget envelope",
  set_period: "Change budget window",
};

const PERIOD_WORDS: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

export function describeIntent(intent: Intent, currency: string): IntentView {
  const money = (n: number) => formatMoney(n, currency);
  const fields: [string, string][] = [];
  const add = (label: string, value: string) => fields.push([label, value]);

  const which = (): string => {
    if (intent.selectorKind === "last") return "Most recent charge";
    if (intent.selectorKind === "amount") return `The ${money(intent.amount)} charge`;
    if (intent.selectorKind === "merchant") return `Matching “${intent.selectorValue}”`;
    return "—";
  };

  const when = (): string => {
    if (intent.daysAgo === 0) return "Today";
    if (intent.daysAgo === 1) return "Yesterday";
    return `${intent.daysAgo} days ago`;
  };

  switch (intent.action) {
    case "add_transaction":
      add("Amount", money(intent.amount));
      if (intent.merchant) add("Merchant", intent.merchant);
      add("When", when());
      add("Budget", intent.category ? intent.category : "Main budget");
      break;

    case "move_transaction":
      add("Which charge", which());
      add("Move into", intent.category || "—");
      break;

    case "set_transaction_amount":
      add("Which charge", which());
      add("New amount", money(intent.newAmount));
      break;

    // Deliberately thin: the row this resolves to is added by planStep, which
    // is the only place that can look it up.
    case "remove_transaction":
      add("Which charge", which());
      break;

    case "unfile_transaction":
      add("Which charge", which());
      add("Move into", "Main budget");
      break;

    case "delete_category":
      add("Envelope", intent.categoryLabel || intent.category || "—");
      // The flag is the whole safety story here, so it is stated as a field
      // rather than left implicit in the summary line.
      add("Its charges", intent.purgeTransactions ? "Deleted too" : "Return to main budget");
      break;

    case "set_budget":
      add("Budget", intent.category ? intent.category : "Main budget");
      add("New limit", money(intent.amount));
      break;

    case "create_category":
      add("Name", intent.categoryLabel || intent.category);
      add("Limit", money(intent.amount));
      add("Resets", PERIOD_WORDS[intent.period === "none" ? "yearly" : intent.period]);
      break;

    case "set_period":
      add("Resets", PERIOD_WORDS[intent.period] ?? intent.period);
      break;

    default:
      break;
  }

  return { title: TITLES[intent.action] ?? intent.action, fields };
}

export interface StepOutcome {
  ok: boolean;
  text: string;
}

interface ProjectedCategory {
  id: number | null; // null = created by an earlier step, not yet in the DB
  label: string;
  amount: number;
  period: Period;
}

interface Projection {
  categories: Map<string, ProjectedCategory>;
  claimedTxnIds: number[];
  budgetAmount: number;
  period: Period;
  currency: string;
  calendar: Calendar;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// "No transaction matching …" — shared by the three actions that resolve a
// single existing transaction from a selector, so the wording can't drift apart.
function noMatchText(intent: Intent, money: (n: number) => string, fallback: string): string {
  const what =
    intent.selectorKind === "amount"
      ? `matching ${money(intent.amount)}`
      : intent.selectorKind === "merchant"
        ? `matching “${esc(intent.selectorValue)}”`
        : fallback;
  return `⚠️ No transaction ${what}.`;
}

// An envelope's display name from its row id, for describing a charge that is
// leaving one. Ids are unique, so the first match is the only match.
function labelForId(p: Projection, id: number | null): string | null {
  if (id === null) return null;
  for (const cat of p.categories.values()) if (cat.id === id) return cat.label;
  return null;
}

// The transaction's date as a LOCAL day. Returns null for a row with no usable
// date rather than letting Intl throw on an invalid one.
function localDay(iso: string | undefined, cal: Calendar): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: cal.timeZone,
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

async function buildProjection(env: Env): Promise<Projection> {
  const [cfg, cats] = await Promise.all([getConfig(env), listCategories(env)]);
  const categories = new Map<string, ProjectedCategory>();
  for (const c of cats) {
    categories.set(c.name, {
      id: c.id,
      label: c.label,
      amount: c.amount,
      period: isPeriod(c.period) ? c.period : "yearly",
    });
  }
  return {
    categories,
    claimedTxnIds: [],
    budgetAmount: cfg.budget_amount,
    period: isPeriod(cfg.period) ? cfg.period : "weekly",
    currency: cfg.currency,
    calendar: calendarFrom(env),
  };
}

/* ------------------------------------------------------------------- plan */

// Validate one step against the projection and, if valid, advance it.
async function planStep(env: Env, intent: Intent, p: Projection): Promise<StepPlan> {
  const money = (n: number) => formatMoney(n, p.currency);

  switch (intent.action) {
    case "add_transaction": {
      if (intent.amount <= 0) return { ok: false, text: "⚠️ No amount given." };
      let where = "";
      if (intent.category) {
        const cat = p.categories.get(intent.category);
        if (!cat) {
          return { ok: false, text: `⚠️ No budget called <b>${esc(intent.category)}</b>.` };
        }
        where = ` to <b>${esc(cat.label)}</b>`;
      }
      const when =
        intent.daysAgo === 0 ? "" : intent.daysAgo === 1 ? " (yesterday)" : ` (${intent.daysAgo}d ago)`;
      const who = intent.merchant ? ` — ${esc(intent.merchant)}` : "";
      return { ok: true, text: `Add ${money(intent.amount)}${who}${where}${when}` };
    }

    case "create_category": {
      if (!intent.category) return { ok: false, text: "⚠️ No budget name given." };
      const period = intent.period === "none" ? "yearly" : intent.period;
      const label = intent.categoryLabel || intent.category;
      const existing = p.categories.get(intent.category);
      p.categories.set(intent.category, {
        id: existing?.id ?? null,
        label,
        amount: intent.amount,
        period,
      });
      return {
        ok: true,
        text: existing
          ? `Update <b>${esc(label)}</b> — ${money(intent.amount)} per ${period}`
          : `Create <b>${esc(label)}</b> — ${money(intent.amount)} per ${period}`,
      };
    }

    case "set_budget": {
      if (intent.amount <= 0) return { ok: false, text: "⚠️ No amount given." };
      if (intent.category) {
        const cat = p.categories.get(intent.category);
        if (!cat) {
          return { ok: false, text: `⚠️ No budget called <b>${esc(intent.category)}</b>.` };
        }
        cat.amount = intent.amount;
        return { ok: true, text: `Set <b>${esc(cat.label)}</b> budget to ${money(intent.amount)}` };
      }
      p.budgetAmount = intent.amount;
      return { ok: true, text: `Set main budget to ${money(intent.amount)}` };
    }

    case "set_period": {
      if (intent.period === "none") return { ok: false, text: "⚠️ No budget window given." };
      p.period = intent.period;
      return { ok: true, text: `Set main budget window to <b>${intent.period}</b>` };
    }

    case "move_transaction": {
      if (intent.selectorKind === "none") {
        return { ok: false, text: "⚠️ Couldn't tell which charge you meant." };
      }
      if (!intent.category) return { ok: false, text: "⚠️ No destination budget given." };
      const cat = p.categories.get(intent.category);
      if (!cat) {
        return {
          ok: false,
          text:
            `⚠️ No budget called <b>${esc(intent.category)}</b> — ` +
            `create it first, or ask for both in one message.`,
        };
      }
      const value = intent.selectorKind === "amount" ? intent.amount : intent.selectorValue;
      // Exclude rows an earlier step already claimed, so "move the last two
      // charges" doesn't resolve to the same transaction twice.
      const txn = await findTransaction(env, intent.selectorKind, value, p.claimedTxnIds);
      if (!txn) return { ok: false, text: noMatchText(intent, money, "to move") };
      p.claimedTxnIds.push(txn.id);
      return {
        ok: true,
        text: `Move ${money(txn.amount)} — ${esc(txn.merchant ?? "unknown")} → <b>${esc(cat.label)}</b>`,
      };
    }

    case "set_transaction_amount": {
      if (intent.selectorKind === "none") {
        return { ok: false, text: "⚠️ Couldn't tell which charge you meant." };
      }
      if (intent.newAmount <= 0) {
        return { ok: false, text: "⚠️ No new amount given." };
      }
      const value = intent.selectorKind === "amount" ? intent.amount : intent.selectorValue;
      const txn = await findTransaction(env, intent.selectorKind, value, p.claimedTxnIds);
      if (!txn) return { ok: false, text: noMatchText(intent, money, "to change") };
      p.claimedTxnIds.push(txn.id);
      return {
        ok: true,
        text:
          `Change ${esc(txn.merchant ?? "unknown")} from ${money(txn.amount)} ` +
          `to <b>${money(intent.newAmount)}</b>`,
      };
    }

    case "remove_transaction": {
      if (intent.selectorKind === "none") {
        return { ok: false, text: "⚠️ Couldn't tell which charge you meant." };
      }
      const value = intent.selectorKind === "amount" ? intent.amount : intent.selectorValue;
      const txn = await findTransaction(env, intent.selectorKind, value, p.claimedTxnIds);
      if (!txn) return { ok: false, text: noMatchText(intent, money, "to remove") };
      p.claimedTxnIds.push(txn.id);
      const who = txn.merchant ?? "unknown";
      const day = localDay(txn.occurred_at, p.calendar);
      return {
        ok: true,
        text: `Remove ${money(txn.amount)} — ${esc(who)}`,
        // "Most recent charge" doesn't say WHICH charge that is, so a
        // selector-only confirmation asks for a blind approval. Name the row
        // the selector actually landed on instead. move_transaction and
        // set_transaction_amount have the same blind spot and can use this
        // too; removal goes first because it takes the whole row at once.
        resolved: [["Removing", `${money(txn.amount)} — ${who}${day ? ` (${day})` : ""}`]],
      };
    }

    case "unfile_transaction": {
      if (intent.selectorKind === "none") {
        return { ok: false, text: "⚠️ Couldn't tell which charge you meant." };
      }
      const value = intent.selectorKind === "amount" ? intent.amount : intent.selectorValue;
      const txn = await findTransaction(env, intent.selectorKind, value, p.claimedTxnIds);
      if (!txn) return { ok: false, text: noMatchText(intent, money, "to move") };
      // Claimed either way, so "move the last two charges back" walks two rows
      // rather than reporting on the same one twice.
      p.claimedTxnIds.push(txn.id);
      if (txn.category_id === null) {
        return {
          ok: true,
          // Not an error: the charge is already where the user wants it, and
          // failing the step would block every other step in the batch.
          text: `Leave ${money(txn.amount)} — ${esc(txn.merchant ?? "unknown")} on the main budget (already there)`,
          resolved: [["Already there", "This charge is on the main budget"]],
        };
      }
      const who = txn.merchant ?? "unknown";
      const day = localDay(txn.occurred_at, p.calendar);
      const from = labelForId(p, txn.category_id);
      return {
        ok: true,
        text: `Return ${money(txn.amount)} — ${esc(who)} to the main budget`,
        resolved: [
          ["Returning", `${money(txn.amount)} — ${who}${day ? ` (${day})` : ""}`],
          ...(from ? ([["Out of", from]] as [string, string][]) : []),
        ],
      };
    }

    case "delete_category": {
      if (!intent.category) return { ok: false, text: "⚠️ No budget name given." };
      const cat = p.categories.get(intent.category);
      if (!cat) return { ok: false, text: `⚠️ No budget called <b>${esc(intent.category)}</b>.` };
      // A category created earlier in this batch has no rows yet, so there is
      // nothing to count and nothing to warn about.
      const filed = cat.id === null ? { n: 0, total: 0 } : await categoryTotals(env, cat.id);
      p.categories.delete(intent.category);
      const fate = intent.purgeTransactions
        ? `${filed.n} charge${filed.n === 1 ? "" : "s"} (${money(filed.total)}) deleted with it`
        : `${filed.n} charge${filed.n === 1 ? "" : "s"} (${money(filed.total)}) return to the main budget`;
      return {
        ok: true,
        text: `Delete <b>${esc(cat.label)}</b> — ${filed.n ? fate : "no charges filed to it"}`,
        // Spelled out because the two dispositions differ by whether real
        // spending survives, and the flag that decides it came from a parse.
        resolved: filed.n ? [["Affects", fate]] : [["Affects", "No charges filed to it"]],
      };
    }

    // Reads are always valid; they run after any writes so they see fresh state.
    case "get_status":
      return { ok: true, text: "Show budget status" };
    case "query_spend":
      return { ok: true, text: "Answer a spending question" };
    case "list_transactions":
      return { ok: true, text: "List transactions" };
    case "report":
      return { ok: true, text: "Show a report" };

    default:
      return { ok: false, text: `⚠️ ${intent.reason || "I didn't follow that part."}` };
  }
}

export async function planBatch(env: Env, intents: Intent[]): Promise<PlannedStep[]> {
  const projection = await buildProjection(env);
  const steps: PlannedStep[] = [];
  for (const intent of intents) {
    const { resolved, ...step } = await planStep(env, intent, projection);
    const view = describeIntent(intent, projection.currency);
    steps.push({
      ...step,
      view: resolved?.length ? { ...view, fields: [...view.fields, ...resolved] } : view,
    });
  }
  return steps;
}

/* ------------------------------------------------------------------ apply */

// Execute one approved mutating step. Re-resolves against live state rather
// than trusting anything computed at planning time.
async function applyStep(
  env: Env,
  intent: Intent,
  claimed: number[],
  currency: string,
): Promise<StepOutcome> {
  const money = (n: number) => formatMoney(n, currency);

  switch (intent.action) {
    case "add_transaction": {
      if (intent.amount <= 0) return { ok: false, text: "No amount given" };
      let categoryId: number | null = null;
      let where = "";
      if (intent.category) {
        const cat = await findCategory(env, intent.category);
        if (!cat) return { ok: false, text: `<b>${esc(intent.category)}</b> no longer exists` };
        categoryId = cat.id;
        where = ` to <b>${esc(cat.label)}</b>`;
      }
      const occurredAt = daysAgo(intent.daysAgo, new Date(), calendarFrom(env)).toISOString();
      await addManualTransaction(
        env,
        intent.amount,
        intent.merchant || null,
        currency,
        occurredAt,
        categoryId,
      );
      const who = intent.merchant ? ` — ${esc(intent.merchant)}` : "";
      return { ok: true, text: `Added ${money(intent.amount)}${who}${where}` };
    }

    case "create_category": {
      const period = intent.period === "none" ? "yearly" : intent.period;
      const label = intent.categoryLabel || intent.category;
      await upsertCategory(env, intent.category, label, intent.amount, period);
      return { ok: true, text: `Created <b>${esc(label)}</b> — ${money(intent.amount)} per ${period}` };
    }

    case "set_budget": {
      if (intent.category) {
        const cat = await findCategory(env, intent.category);
        if (!cat) return { ok: false, text: `<b>${esc(intent.category)}</b> no longer exists` };
        await setCategoryBudget(env, cat.id, intent.amount);
        return { ok: true, text: `<b>${esc(cat.label)}</b> budget set to ${money(intent.amount)}` };
      }
      await setBudget(env, intent.amount);
      return { ok: true, text: `Main budget set to ${money(intent.amount)}` };
    }

    case "set_period": {
      if (intent.period === "none") return { ok: false, text: "No budget window given" };
      await setPeriod(env, intent.period as Period);
      return { ok: true, text: `Budget window set to <b>${intent.period}</b>` };
    }

    case "move_transaction": {
      if (intent.selectorKind === "none" || !intent.category) {
        return { ok: false, text: "That move is no longer valid" };
      }
      const cat = await findCategory(env, intent.category);
      if (!cat) return { ok: false, text: `<b>${esc(intent.category)}</b> no longer exists` };
      const value = intent.selectorKind === "amount" ? intent.amount : intent.selectorValue;
      const txn = await findTransaction(env, intent.selectorKind, value, claimed);
      if (!txn) return { ok: false, text: "That transaction is no longer there" };
      claimed.push(txn.id);
      await setTxnCategory(env, txn.id, cat.id);
      return {
        ok: true,
        text: `Moved ${money(txn.amount)} — ${esc(txn.merchant ?? "unknown")} → <b>${esc(cat.label)}</b>`,
      };
    }

    case "set_transaction_amount": {
      if (intent.selectorKind === "none" || intent.newAmount <= 0) {
        return { ok: false, text: "That change is no longer valid" };
      }
      const value = intent.selectorKind === "amount" ? intent.amount : intent.selectorValue;
      const txn = await findTransaction(env, intent.selectorKind, value, claimed);
      if (!txn) return { ok: false, text: "That transaction is no longer there" };
      claimed.push(txn.id);
      await setTxnAmount(env, txn.id, intent.newAmount);
      return {
        ok: true,
        text:
          `Changed ${esc(txn.merchant ?? "unknown")} from ${money(txn.amount)} ` +
          `to <b>${money(intent.newAmount)}</b>`,
      };
    }

    case "remove_transaction": {
      if (intent.selectorKind === "none") {
        return { ok: false, text: "That removal is no longer valid" };
      }
      const value = intent.selectorKind === "amount" ? intent.amount : intent.selectorValue;
      const txn = await findTransaction(env, intent.selectorKind, value, claimed);
      if (!txn) return { ok: false, text: "That transaction is no longer there" };
      claimed.push(txn.id);
      await deleteTransaction(env, txn.id);
      return {
        ok: true,
        text: `Removed ${money(txn.amount)} — ${esc(txn.merchant ?? "unknown")}`,
      };
    }

    case "unfile_transaction": {
      if (intent.selectorKind === "none") {
        return { ok: false, text: "That move is no longer valid" };
      }
      const value = intent.selectorKind === "amount" ? intent.amount : intent.selectorValue;
      const txn = await findTransaction(env, intent.selectorKind, value, claimed);
      if (!txn) return { ok: false, text: "That transaction is no longer there" };
      claimed.push(txn.id);
      if (txn.category_id === null) {
        return { ok: true, text: `${esc(txn.merchant ?? "unknown")} was already on the main budget` };
      }
      await setTxnCategory(env, txn.id, null);
      return {
        ok: true,
        text: `Returned ${money(txn.amount)} — ${esc(txn.merchant ?? "unknown")} to the main budget`,
      };
    }

    case "delete_category": {
      const cat = await findCategory(env, intent.category);
      if (!cat) return { ok: false, text: `<b>${esc(intent.category)}</b> no longer exists` };
      const filed = await categoryTotals(env, cat.id);
      await deleteCategory(env, cat.id, intent.purgeTransactions);
      const tail = !filed.n
        ? ""
        : intent.purgeTransactions
          ? ` — ${filed.n} charge${filed.n === 1 ? "" : "s"} (${money(filed.total)}) deleted with it`
          : ` — ${filed.n} charge${filed.n === 1 ? "" : "s"} (${money(filed.total)}) returned to the main budget`;
      return { ok: true, text: `Deleted <b>${esc(cat.label)}</b>${tail}` };
    }

    default:
      return { ok: true, text: "" }; // reads are handled by the caller
  }
}

// Apply the mutating steps of an approved batch, in order. Stops at nothing —
// a failed step is reported and the rest still run, because the plan was
// validated upfront and a late failure means the world changed underneath us.
export async function applyBatch(env: Env, intents: Intent[]): Promise<StepOutcome[]> {
  const cfg = await getConfig(env);
  const claimed: number[] = [];
  const outcomes: StepOutcome[] = [];
  for (const intent of intents) {
    if (!isMutating(intent.action)) continue;
    try {
      outcomes.push(await applyStep(env, intent, claimed, cfg.currency));
    } catch (err) {
      console.error("applyStep failed:", err);
      outcomes.push({ ok: false, text: "Something went wrong on this step" });
    }
  }
  return outcomes;
}
