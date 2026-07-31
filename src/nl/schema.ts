// Intent schema for natural-language messages.
//
// A message can carry SEVERAL ordered actions ("create a gift budget and move
// the last $200 into it"), so the model returns { actions: [ ... ] }.
//
// SHAPE NOTE (deliberate): each action is one FLAT object with every field
// REQUIRED and no `anyOf` / union types anywhere. The obvious modelling — a
// discriminated union with one branch per action and optional per-branch fields
// — runs into two API limits: at most 24 optional parameters, and at most 16
// parameters using `anyOf` or type arrays, per request. Exceeding the grammar's
// internal limits fails the request with "Schema is too complex for
// compilation", which would surface as a hard 400 on a user's message rather
// than at build time.
//
// So: irrelevant fields carry sentinels ("" / 0 / "none") instead of being
// absent or null, and normalizeIntent() below turns that back into a typed
// discriminated union for the rest of the app. Current counts, keep them low:
//   required params: 11 (1 wrapper + 10 item)   optional: 0   anyOf/type-array: 0

export const MAX_ACTIONS = 5;

const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "category",
    "category_label",
    "merchant",
    "amount",
    "new_amount",
    "days_ago",
    "period",
    "window",
    "period_offset",
    "scope",
    "selector_kind",
    "selector_value",
    "limit",
    "reason",
  ],
  properties: {
    action: {
      type: "string",
      enum: [
        "get_status",
        "query_spend",
        "list_transactions",
        "add_transaction",
        "move_transaction",
        "set_transaction_amount",
        "set_budget",
        "create_category",
        "set_period",
        "unknown",
      ],
      description: "What the user is asking for. Use 'unknown' when unsure — never guess.",
    },
    category: {
      type: "string",
      description:
        "Lowercase envelope key the message refers to, e.g. 'gift'. Prefer an EXISTING category name from the context when the user clearly means it. Empty string when the message is about the default budget or no category applies.",
    },
    category_label: {
      type: "string",
      description:
        "Human-readable name for a NEW category being created, e.g. 'Yearly gift budget'. Empty string otherwise.",
    },
    amount: {
      type: "number",
      description:
        "The money amount in the message. For add_transaction, how much was spent. For set_budget and create_category, the budget limit. For move_transaction and set_transaction_amount with selector_kind 'amount', the amount that identifies which existing transaction is meant. 0 only when the message truly has no amount.",
    },
    new_amount: {
      type: "number",
      description:
        "For set_transaction_amount only: the corrected amount the transaction should become. In 'change the $84 charge to $48', amount is 84 (which transaction) and new_amount is 48 (what it becomes). 0 when not applicable.",
    },
    merchant: {
      type: "string",
      description:
        "For add_transaction: where the money went, e.g. 'Corner Cafe'. Use the user's own words; empty string if they didn't say.",
    },
    days_ago: {
      type: "integer",
      description:
        "For add_transaction: how many days back the spend happened. 0 = today, 1 = yesterday. Use 0 unless the user says otherwise.",
    },
    period: {
      type: "string",
      enum: ["weekly", "monthly", "yearly", "none"],
      description: "Budget window for set_period/create_category. 'none' when not applicable.",
    },
    window: {
      type: "string",
      enum: ["week", "month", "year", "none"],
      description:
        "Time window for query_spend and list_transactions. For list_transactions, 'week' means one calendar week (Monday to Sunday). Use 'none' on list_transactions to mean 'the most recent transactions' regardless of date.",
    },
    period_offset: {
      type: "integer",
      description:
        "Which window, counting back from the current one: 0 = this week/month/year, 1 = last, 2 = the one before. Use 0 unless the user asks for an earlier one.",
    },
    scope: {
      type: "string",
      enum: ["main", "category", "all"],
      description:
        "Which spending to include. 'main' = only the main budget, excluding money filed to a named envelope — this is what 'my weekly spending' means. 'category' = only the envelope named in category. 'all' = everything. Default to 'main'.",
    },
    selector_kind: {
      type: "string",
      enum: ["last", "amount", "merchant", "none"],
      description:
        "How to find the transaction for move_transaction. 'last' = most recent. 'none' when not applicable.",
    },
    selector_value: {
      type: "string",
      description:
        "Merchant text to match when selector_kind is 'merchant'. Empty string otherwise.",
    },
    limit: {
      type: "integer",
      description: "How many rows for list_recent. 0 means use the default.",
    },
    reason: {
      type: "string",
      description:
        "When action is 'unknown', a short plain-English explanation of what was unclear. Empty string otherwise.",
    },
  },
} as const;

export const INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      // No minItems/maxItems: structured outputs reject "complex array
      // constraints", which fails the whole request. The bound is stated in the
      // description for the model and enforced for real in normalizeBatch(),
      // which caps the list and never returns it empty.
      description:
        `The actions to take, in the order the user stated them. Usually exactly one; ` +
        `never more than ${MAX_ACTIONS}. Use several only when the message genuinely asks for several things.`,
      items: ACTION_SCHEMA,
    },
  },
} as const;

// Exported for the schema-complexity tests, which count parameters across the
// wrapper and the item to keep the request inside the grammar's limits.
export const ACTION_ITEM_SCHEMA = ACTION_SCHEMA;

export type Action =
  | "get_status"
  | "query_spend"
  | "list_transactions"
  | "add_transaction"
  | "move_transaction"
  | "set_transaction_amount"
  | "set_budget"
  | "create_category"
  | "set_period"
  | "unknown";

export type SelectorKind = "last" | "amount" | "merchant" | "none";
export type Window = "week" | "month" | "year" | "none";
export type Scope = "main" | "category" | "all";
export type PeriodOrNone = "weekly" | "monthly" | "yearly" | "none";

// The normalized, trusted shape the rest of the app works with.
export interface Intent {
  action: Action;
  category: string;
  categoryLabel: string;
  merchant: string;
  amount: number;
  newAmount: number;
  daysAgo: number;
  period: PeriodOrNone;
  window: Window;
  periodOffset: number;
  scope: Scope;
  selectorKind: SelectorKind;
  selectorValue: string;
  limit: number;
  reason: string;
}

// Which actions change stored data (and therefore need confirmation).
const MUTATING: ReadonlySet<Action> = new Set<Action>([
  "add_transaction",
  "move_transaction",
  "set_transaction_amount",
  "set_budget",
  "create_category",
  "set_period",
]);

export function isMutating(action: Action): boolean {
  return MUTATING.has(action);
}

const ACTIONS = new Set(ACTION_SCHEMA.properties.action.enum as readonly string[]);
const PERIODS = new Set(ACTION_SCHEMA.properties.period.enum as readonly string[]);
const WINDOWS = new Set(ACTION_SCHEMA.properties.window.enum as readonly string[]);
const SELECTORS = new Set(ACTION_SCHEMA.properties.selector_kind.enum as readonly string[]);
const SCOPES = new Set(ACTION_SCHEMA.properties.scope.enum as readonly string[]);

// Structured outputs constrain which enum value is chosen but NOT its
// capitalization, so every enum comparison here is case-insensitive. Anything
// unrecognized degrades to the safe value rather than throwing.
function pickEnum<T extends string>(raw: unknown, allowed: Set<string>, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  const lowered = raw.trim().toLowerCase();
  return allowed.has(lowered) ? (lowered as T) : fallback;
}

function str(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function num(raw: unknown): number {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : 0;
}

// Turn a raw intent into a trusted Intent. Never throws.
//
// Accepts BOTH key styles, and must keep doing so: the model emits the schema's
// snake_case (`selector_kind`), while an intent staged in `pending_actions` was
// serialized from an already-normalized Intent and comes back camelCase
// (`selectorKind`). Reading only snake_case silently drops those fields on the
// round trip, which turns every confirmed move into "no longer valid".
export function normalizeIntent(raw: unknown): Intent {
  const o = (raw ?? {}) as Record<string, unknown>;
  const either = (snake: string, camel: string): unknown => o[snake] ?? o[camel];
  const action = pickEnum<Action>(o.action, ACTIONS, "unknown");
  const amount = Math.abs(num(o.amount));
  const newAmount = Math.abs(num(either("new_amount", "newAmount")));
  return {
    action,
    category: str(o.category).toLowerCase(),
    categoryLabel: str(either("category_label", "categoryLabel")),
    merchant: str(o.merchant),
    // Adding a transaction has only one amount, so if it landed in new_amount
    // take it rather than rejecting a message that plainly stated a figure.
    amount: action === "add_transaction" && amount === 0 ? newAmount : amount,
    newAmount,
    // Clamped to a year: a mistyped 20260 must not backdate spend out of every
    // budget period and silently vanish from the totals.
    daysAgo: Math.min(365, Math.max(0, Math.trunc(num(either("days_ago", "daysAgo"))))),
    period: pickEnum<PeriodOrNone>(o.period, PERIODS, "none"),
    window: pickEnum<Window>(o.window, WINDOWS, "none"),
    // Bounded: an unbounded offset would silently query an empty range far in
    // the past and read as "you spent nothing" rather than as a bad request.
    periodOffset: Math.min(520, Math.max(0, Math.trunc(num(either("period_offset", "periodOffset"))))),
    // A named category implies category scope even if the model didn't say so.
    scope: (() => {
      const s = pickEnum<Scope>(o.scope, SCOPES, "main");
      return s === "main" && str(o.category) ? "category" : s;
    })(),
    selectorKind: pickEnum<SelectorKind>(either("selector_kind", "selectorKind"), SELECTORS, "none"),
    selectorValue: str(either("selector_value", "selectorValue")),
    limit: Math.min(20, Math.max(0, Math.trunc(num(o.limit)))),
    reason: str(o.reason),
  };
}

export function unknownIntent(reason: string): Intent {
  return normalizeIntent({ action: "unknown", reason });
}

// Turn a raw model response into an ordered list of trusted Intents.
// Never throws and never returns an empty array — callers can always assume at
// least one step, so "nothing to do" is expressed as a single `unknown`.
//
// Also accepts a bare action object: pending_actions rows written before this
// change stored a single intent, and one could still be mid-flight at deploy.
export function normalizeBatch(raw: unknown): Intent[] {
  const source =
    raw && typeof raw === "object" && Array.isArray((raw as { actions?: unknown }).actions)
      ? (raw as { actions: unknown[] }).actions
      : Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object"
          ? [raw] // legacy single-intent shape
          : [];

  const intents = source.slice(0, MAX_ACTIONS).map(normalizeIntent);
  if (!intents.length) return [unknownIntent("I didn't get anything I could act on.")];
  return intents;
}

// A batch needs confirmation when any step writes.
export function batchMutates(intents: Intent[]): boolean {
  return intents.some((i) => isMutating(i.action));
}
