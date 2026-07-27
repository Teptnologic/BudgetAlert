// Intent schema for natural-language messages.
//
// SHAPE NOTE (deliberate): this is one FLAT object with every field REQUIRED and
// no `anyOf` / union types anywhere. The obvious modelling — a discriminated
// union with one branch per action and optional per-branch fields — runs into
// two API limits: at most 24 optional parameters, and at most 16 parameters
// using `anyOf` or type arrays, per request. Exceeding the grammar's internal
// limits fails the request with "Schema is too complex for compilation", which
// would surface as a hard 400 on a user's message rather than at build time.
//
// So: irrelevant fields carry sentinels ("" / 0 / "none") instead of being
// absent or null, and normalizeIntent() below turns that back into a typed
// discriminated union for the rest of the app. Current counts, keep them low:
//   required params: 10   optional: 0   anyOf/type-array params: 0

export const INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "category",
    "category_label",
    "amount",
    "period",
    "window",
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
        "list_recent",
        "move_transaction",
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
        "Money amount in the message for set_budget/create_category, or the amount used to identify a transaction when selector_kind is 'amount'. 0 when not applicable.",
    },
    period: {
      type: "string",
      enum: ["weekly", "monthly", "yearly", "none"],
      description: "Budget window for set_period/create_category. 'none' when not applicable.",
    },
    window: {
      type: "string",
      enum: ["week", "month", "year", "none"],
      description: "Look-back window for query_spend. 'none' when not applicable.",
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

export type Action =
  | "get_status"
  | "query_spend"
  | "list_recent"
  | "move_transaction"
  | "set_budget"
  | "create_category"
  | "set_period"
  | "unknown";

export type SelectorKind = "last" | "amount" | "merchant" | "none";
export type Window = "week" | "month" | "year" | "none";
export type PeriodOrNone = "weekly" | "monthly" | "yearly" | "none";

// The normalized, trusted shape the rest of the app works with.
export interface Intent {
  action: Action;
  category: string;
  categoryLabel: string;
  amount: number;
  period: PeriodOrNone;
  window: Window;
  selectorKind: SelectorKind;
  selectorValue: string;
  limit: number;
  reason: string;
}

// Which actions change stored data (and therefore need confirmation).
const MUTATING: ReadonlySet<Action> = new Set<Action>([
  "move_transaction",
  "set_budget",
  "create_category",
  "set_period",
]);

export function isMutating(action: Action): boolean {
  return MUTATING.has(action);
}

const ACTIONS = new Set(INTENT_SCHEMA.properties.action.enum as readonly string[]);
const PERIODS = new Set(INTENT_SCHEMA.properties.period.enum as readonly string[]);
const WINDOWS = new Set(INTENT_SCHEMA.properties.window.enum as readonly string[]);
const SELECTORS = new Set(INTENT_SCHEMA.properties.selector_kind.enum as readonly string[]);

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

// Turn a raw model response into a trusted Intent. Never throws.
export function normalizeIntent(raw: unknown): Intent {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    action: pickEnum<Action>(o.action, ACTIONS, "unknown"),
    category: str(o.category).toLowerCase(),
    categoryLabel: str(o.category_label),
    amount: Math.abs(num(o.amount)),
    period: pickEnum<PeriodOrNone>(o.period, PERIODS, "none"),
    window: pickEnum<Window>(o.window, WINDOWS, "none"),
    selectorKind: pickEnum<SelectorKind>(o.selector_kind, SELECTORS, "none"),
    selectorValue: str(o.selector_value),
    limit: Math.min(20, Math.max(0, Math.trunc(num(o.limit)))),
    reason: str(o.reason),
  };
}

export function unknownIntent(reason: string): Intent {
  return normalizeIntent({ action: "unknown", reason });
}
