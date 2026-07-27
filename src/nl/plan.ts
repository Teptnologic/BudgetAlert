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
import type { Intent } from "./schema";
import { isMutating } from "./schema";
import { isPeriod, type Period } from "../core/period";
import { formatMoney } from "../core/engine";
import {
  getConfig,
  listCategories,
  findCategory,
  findTransaction,
  upsertCategory,
  setCategoryBudget,
  setTxnCategory,
  setTxnAmount,
  setBudget,
  setPeriod,
} from "../store/d1";

export interface PlannedStep {
  ok: boolean;
  /** What this step will do, or why it can't. */
  text: string;
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
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  };
}

/* ------------------------------------------------------------------- plan */

// Validate one step against the projection and, if valid, advance it.
async function planStep(env: Env, intent: Intent, p: Projection): Promise<PlannedStep> {
  const money = (n: number) => formatMoney(n, p.currency);

  switch (intent.action) {
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
      if (!txn) {
        const what =
          intent.selectorKind === "amount"
            ? `matching ${money(intent.amount)}`
            : intent.selectorKind === "merchant"
              ? `matching “${esc(intent.selectorValue)}”`
              : "to move";
        return { ok: false, text: `⚠️ No transaction ${what}.` };
      }
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
      if (!txn) {
        const what =
          intent.selectorKind === "amount"
            ? `matching ${money(intent.amount)}`
            : intent.selectorKind === "merchant"
              ? `matching “${esc(intent.selectorValue)}”`
              : "to change";
        return { ok: false, text: `⚠️ No transaction ${what}.` };
      }
      p.claimedTxnIds.push(txn.id);
      return {
        ok: true,
        text:
          `Change ${esc(txn.merchant ?? "unknown")} from ${money(txn.amount)} ` +
          `to <b>${money(intent.newAmount)}</b>`,
      };
    }

    // Reads are always valid; they run after any writes so they see fresh state.
    case "get_status":
      return { ok: true, text: "Show budget status" };
    case "query_spend":
      return { ok: true, text: "Answer a spending question" };
    case "list_recent":
      return { ok: true, text: "List recent transactions" };

    default:
      return { ok: false, text: `⚠️ ${intent.reason || "I didn't follow that part."}` };
  }
}

export async function planBatch(env: Env, intents: Intent[]): Promise<PlannedStep[]> {
  const projection = await buildProjection(env);
  const steps: PlannedStep[] = [];
  for (const intent of intents) {
    steps.push(await planStep(env, intent, projection));
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
