import { describe, it, expect } from "vitest";
import {
  INTENT_SCHEMA,
  ACTION_ITEM_SCHEMA,
  MAX_ACTIONS,
  normalizeIntent,
  normalizeBatch,
  batchMutates,
  isMutating,
  unknownIntent,
} from "../src/nl/schema";
import { planBatch, describeIntent } from "../src/nl/plan";
import { executeBatch } from "../src/nl/execute";
import { periodStart, periodStartAt, periodEnd, periodLabel, isPeriod } from "../src/core/period";

// The API caps a request at 24 optional parameters and 16 parameters using
// `anyOf` or type arrays; exceeding the grammar's limits fails with
// "Schema is too complex for compilation" — a 400 on a user's message rather
// than a build error. These tests fail the build instead, so a future field
// added to the schema can't quietly push it over. Counts span the wrapper and
// the array item, since the grammar is compiled from the whole request.
describe("INTENT_SCHEMA complexity budget", () => {
  const wrapperProps = Object.entries(INTENT_SCHEMA.properties as Record<string, any>);
  const itemProps = Object.entries(ACTION_ITEM_SCHEMA.properties as Record<string, any>);
  const allProps = [...wrapperProps, ...itemProps];
  const wrapperRequired = new Set(INTENT_SCHEMA.required as readonly string[]);
  const itemRequired = new Set(ACTION_ITEM_SCHEMA.required as readonly string[]);

  it("has no optional parameters", () => {
    const optional = [
      ...wrapperProps.filter(([n]) => !wrapperRequired.has(n)).map(([n]) => n),
      ...itemProps.filter(([n]) => !itemRequired.has(n)).map(([n]) => n),
    ];
    expect(optional).toEqual([]);
    expect(optional.length).toBeLessThanOrEqual(24);
  });

  it("uses no anyOf or type arrays", () => {
    const unions = allProps.filter(([, spec]) => "anyOf" in spec || Array.isArray(spec.type));
    expect(unions).toEqual([]);
    expect(unions.length).toBeLessThanOrEqual(16);
  });

  it("keeps the action item flat — no nested objects or arrays", () => {
    const nested = itemProps
      .filter(([, spec]) => spec.type === "object" || spec.type === "array")
      .map(([n]) => n);
    expect(nested).toEqual([]);
  });

  it("wraps actions in an array", () => {
    const actions = INTENT_SCHEMA.properties.actions as any;
    expect(actions.type).toBe("array");
    expect(actions.items).toBe(ACTION_ITEM_SCHEMA);
  });

  // Structured outputs reject unsupported constraints — array bounds, numeric
  // ranges, string lengths — and the whole request 400s. The action cap is
  // enforced in normalizeBatch() instead; see the normalizeBatch tests.
  it("carries no constraint keywords structured outputs would reject", () => {
    const banned = [
      "minItems",
      "maxItems",
      "uniqueItems",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "pattern",
      "minProperties",
      "maxProperties",
    ];
    const found: string[] = [];
    const walk = (node: any, path: string) => {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (banned.includes(k)) found.push(`${path}.${k}`);
        if (v && typeof v === "object") walk(v, `${path}.${k}`);
      }
    };
    walk(INTENT_SCHEMA, "schema");
    expect(found).toEqual([]);
  });

  it("forbids extra properties and requires every declared property", () => {
    expect(INTENT_SCHEMA.additionalProperties).toBe(false);
    expect(ACTION_ITEM_SCHEMA.additionalProperties).toBe(false);
    expect(wrapperRequired.size).toBe(wrapperProps.length);
    expect(itemRequired.size).toBe(itemProps.length);
  });
});

describe("normalizeBatch", () => {
  it("reads the actions array", () => {
    const b = normalizeBatch({
      actions: [{ action: "create_category", category: "gift" }, { action: "get_status" }],
    });
    expect(b).toHaveLength(2);
    expect(b[0].action).toBe("create_category");
    expect(b[1].action).toBe("get_status");
  });

  it("preserves the stated order", () => {
    const b = normalizeBatch({
      actions: [{ action: "create_category" }, { action: "move_transaction" }],
    });
    expect(b.map((i) => i.action)).toEqual(["create_category", "move_transaction"]);
  });

  // pending_actions rows written before batching stored a single intent object.
  it("accepts a legacy bare intent object", () => {
    const b = normalizeBatch({ action: "set_budget", amount: 400 });
    expect(b).toHaveLength(1);
    expect(b[0].action).toBe("set_budget");
    expect(b[0].amount).toBe(400);
  });

  it("accepts a bare array", () => {
    expect(normalizeBatch([{ action: "get_status" }])).toHaveLength(1);
  });

  it(`caps at ${MAX_ACTIONS} actions`, () => {
    const many = Array.from({ length: 12 }, () => ({ action: "get_status" }));
    expect(normalizeBatch({ actions: many })).toHaveLength(MAX_ACTIONS);
  });

  it("never returns empty — callers always get at least one step", () => {
    for (const bad of [null, undefined, {}, { actions: [] }, [], "nonsense", 42]) {
      const b = normalizeBatch(bad);
      expect(b.length).toBeGreaterThanOrEqual(1);
      expect(b[0].action).toBe("unknown");
    }
  });

  it("degrades a bad step inside a good batch to unknown", () => {
    const b = normalizeBatch({
      actions: [{ action: "get_status" }, { action: "drop_all_tables" }],
    });
    expect(b[0].action).toBe("get_status");
    expect(b[1].action).toBe("unknown");
  });
});

describe("batchMutates", () => {
  it("is true when any step writes", () => {
    expect(
      batchMutates(normalizeBatch({ actions: [{ action: "get_status" }, { action: "set_budget" }] })),
    ).toBe(true);
  });

  it("is false for a read-only batch", () => {
    expect(
      batchMutates(
        normalizeBatch({ actions: [{ action: "get_status" }, { action: "list_transactions" }] }),
      ),
    ).toBe(false);
  });

  it("is false for an unparseable message", () => {
    expect(batchMutates(normalizeBatch(null))).toBe(false);
  });
});

describe("normalizeIntent", () => {
  it("parses a well-formed move intent", () => {
    const i = normalizeIntent({
      action: "move_transaction",
      category: "gift",
      category_label: "",
      amount: 200,
      period: "none",
      window: "none",
      selector_kind: "last",
      selector_value: "",
      limit: 0,
      reason: "",
    });
    expect(i.action).toBe("move_transaction");
    expect(i.category).toBe("gift");
    expect(i.selectorKind).toBe("last");
  });

  // Structured outputs constrain WHICH enum value is chosen but not its
  // capitalization, so every enum comparison must be case-insensitive.
  it("accepts enum values in any capitalization", () => {
    const i = normalizeIntent({
      action: "Move_Transaction",
      category: "GIFT",
      period: "Yearly",
      window: "YEAR",
      selector_kind: "LAST",
    });
    expect(i.action).toBe("move_transaction");
    expect(i.category).toBe("gift");
    expect(i.period).toBe("yearly");
    expect(i.window).toBe("year");
    expect(i.selectorKind).toBe("last");
  });

  it("degrades unrecognized enum values to safe defaults", () => {
    const i = normalizeIntent({ action: "delete_everything", period: "fortnightly" });
    expect(i.action).toBe("unknown");
    expect(i.period).toBe("none");
  });

  it("survives a missing, null, or malformed payload", () => {
    for (const bad of [null, undefined, {}, { action: 42 }, "nonsense"]) {
      const i = normalizeIntent(bad);
      expect(i.action).toBe("unknown");
      expect(i.amount).toBe(0);
    }
  });

  // Regression: the `amount` description didn't list add_transaction, so the
  // model put the figure in new_amount and every "add a spending of $X" was
  // rejected with "no amount given".
  it("recovers an add_transaction amount that landed in new_amount", () => {
    const i = normalizeIntent({
      action: "add_transaction",
      merchant: "water heater",
      category: "gift",
      amount: 0,
      new_amount: 166.67,
    });
    expect(i.amount).toBe(166.67);
  });

  it("does not let that fallback disturb a correction's two amounts", () => {
    const i = normalizeIntent({
      action: "set_transaction_amount",
      selector_kind: "amount",
      amount: 84,
      new_amount: 48.6,
    });
    expect(i.amount).toBe(84);
    expect(i.newAmount).toBe(48.6);
  });

  it("keeps a normal add_transaction amount untouched", () => {
    const i = normalizeIntent({ action: "add_transaction", amount: 12, new_amount: 0 });
    expect(i.amount).toBe(12);
  });

  it("coerces amounts to a positive number", () => {
    expect(normalizeIntent({ amount: -200 }).amount).toBe(200);
    expect(normalizeIntent({ amount: "84.50" }).amount).toBe(84.5);
    expect(normalizeIntent({ amount: "abc" }).amount).toBe(0);
  });

  it("clamps limit into a sane range", () => {
    expect(normalizeIntent({ limit: 9999 }).limit).toBe(20);
    expect(normalizeIntent({ limit: -5 }).limit).toBe(0);
  });

  it("trims whitespace from text fields", () => {
    expect(normalizeIntent({ category: "  gift  " }).category).toBe("gift");
  });

  // Regression: an intent staged in pending_actions is serialized from an
  // already-normalized Intent, so it comes back camelCase. Reading only the
  // model's snake_case dropped selectorKind/categoryLabel on the round trip and
  // turned every confirmed move into "no longer valid".
  it("survives a storage round trip with its camelCase keys intact", () => {
    const fromModel = normalizeIntent({
      action: "move_transaction",
      category: "gift",
      category_label: "Yearly gift budget",
      selector_kind: "merchant",
      selector_value: "TOP GOLF",
    });
    const roundTripped = normalizeIntent(JSON.parse(JSON.stringify(fromModel)));
    expect(roundTripped).toEqual(fromModel);
    expect(roundTripped.selectorKind).toBe("merchant");
    expect(roundTripped.selectorValue).toBe("TOP GOLF");
    expect(roundTripped.categoryLabel).toBe("Yearly gift budget");
  });

  it("round trips a whole batch through storage", () => {
    const batch = normalizeBatch({
      actions: [
        { action: "create_category", category: "gift", category_label: "Gift", amount: 1200, period: "yearly" },
        { action: "move_transaction", category: "gift", selector_kind: "last" },
      ],
    });
    expect(normalizeBatch(JSON.parse(JSON.stringify(batch)))).toEqual(batch);
  });
});

describe("isMutating", () => {
  it("flags exactly the write actions", () => {
    for (const a of [
      "move_transaction",
      "set_transaction_amount",
      "set_budget",
      "create_category",
      "set_period",
    ] as const) {
      expect(isMutating(a)).toBe(true);
    }
    for (const a of ["get_status", "query_spend", "list_transactions", "unknown"] as const) {
      expect(isMutating(a)).toBe(false);
    }
  });

  it("treats an unparseable message as a non-mutating unknown", () => {
    expect(isMutating(unknownIntent("nope").action)).toBe(false);
  });
});

/* ------------------------------------------------------------- projection */

// Minimal D1 stub: dispatches on the SQL text so planBatch/executeBatch can run
// offline. Exercises the real projection logic, which is the point of batching.
function fakeEnv(opts: {
  categories?: { id: number; name: string; label: string; amount: number; period: string }[];
  transactions?: { id: number; amount: number; merchant: string | null }[];
}): any {
  const cats = opts.categories ?? [];
  const txns = opts.transactions ?? []; // newest first
  const cfg = {
    budget_amount: 500,
    currency: "USD",
    period: "weekly",
    warn_pct: 80,
    alert_pct: 100,
    group_chat_id: "1",
  };

  const DB = {
    prepare(sql: string) {
      let binds: any[] = [];
      const api: any = {
        bind(...args: any[]) {
          binds = args;
          return api;
        },
        async first() {
          if (sql.includes("FROM config")) return cfg;
          if (sql.includes("FROM categories")) {
            return cats.find((c) => c.name === binds[0]) ?? null;
          }
          if (sql.includes("FROM transactions")) {
            const m = sql.match(/id NOT IN \(([^)]*)\)/);
            const excluded = m ? m[1].split(",").map(Number) : [];
            let pool = txns.filter((t) => !excluded.includes(t.id));
            if (sql.includes("ABS(amount")) {
              pool = pool.filter((t) => Math.abs(t.amount - Number(binds[0])) < 0.005);
            }
            if (sql.includes("merchant LIKE")) {
              const needle = String(binds[0]).replace(/%/g, "").toLowerCase();
              pool = pool.filter((t) => (t.merchant ?? "").toLowerCase().includes(needle));
            }
            return pool[0] ?? null;
          }
          return null;
        },
        async all() {
          return { results: sql.includes("FROM categories") ? cats : [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return api;
    },
  };
  return { DB };
}

describe("planBatch projection", () => {
  const txns = [
    { id: 9, amount: 200, merchant: "TOP GOLF BAY RESERVA" },
    { id: 8, amount: 84, merchant: "STARBUCKS" },
  ];

  // The case that motivates the whole feature: step 2 must validate against a
  // world where step 1 already ran.
  it("lets a move depend on a category created earlier in the same batch", async () => {
    const env = fakeEnv({ transactions: txns });
    const steps = await planBatch(
      env,
      normalizeBatch({
        actions: [
          { action: "create_category", category: "gift", category_label: "Gift", amount: 1200, period: "yearly" },
          { action: "move_transaction", category: "gift", selector_kind: "last" },
        ],
      }),
    );
    expect(steps.map((s) => s.ok)).toEqual([true, true]);
    expect(steps[0].text).toContain("Create");
    expect(steps[1].text).toContain("TOP GOLF BAY RESERVA");
  });

  it("rejects a move into a category that no step creates", async () => {
    const env = fakeEnv({ transactions: txns });
    const steps = await planBatch(
      env,
      normalizeBatch({ actions: [{ action: "move_transaction", category: "gift", selector_kind: "last" }] }),
    );
    expect(steps[0].ok).toBe(false);
    expect(steps[0].text).toContain("No budget called");
  });

  // Without claimedTxnIds both steps resolve to the newest row and one move is
  // silently lost.
  it("does not resolve two 'last charge' steps to the same transaction", async () => {
    const env = fakeEnv({
      categories: [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }],
      transactions: txns,
    });
    const steps = await planBatch(
      env,
      normalizeBatch({
        actions: [
          { action: "move_transaction", category: "gift", selector_kind: "last" },
          { action: "move_transaction", category: "gift", selector_kind: "last" },
        ],
      }),
    );
    expect(steps.map((s) => s.ok)).toEqual([true, true]);
    expect(steps[0].text).toContain("TOP GOLF BAY RESERVA");
    expect(steps[1].text).toContain("STARBUCKS");
  });

  it("plans a manual transaction", async () => {
    const env = fakeEnv({});
    const steps = await planBatch(
      env,
      normalizeBatch({
        actions: [{ action: "add_transaction", amount: 12, merchant: "lunch", days_ago: 1 }],
      }),
    );
    expect(steps[0].ok).toBe(true);
    expect(steps[0].text).toContain("$12.00");
    expect(steps[0].text).toContain("lunch");
    expect(steps[0].text).toContain("yesterday");
  });

  it("rejects a manual transaction with no amount", async () => {
    const steps = await planBatch(
      fakeEnv({}),
      normalizeBatch({ actions: [{ action: "add_transaction", merchant: "lunch" }] }),
    );
    expect(steps[0].ok).toBe(false);
    expect(steps[0].text).toContain("No amount");
  });

  it("can file a manual transaction straight into an envelope", async () => {
    const env = fakeEnv({
      categories: [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }],
    });
    const steps = await planBatch(
      env,
      normalizeBatch({
        actions: [{ action: "add_transaction", amount: 40, merchant: "flowers", category: "gift" }],
      }),
    );
    expect(steps[0].ok).toBe(true);
    expect(steps[0].text).toContain("Gift");
  });

  it("rejects filing a manual transaction into an unknown envelope", async () => {
    const steps = await planBatch(
      fakeEnv({}),
      normalizeBatch({
        actions: [{ action: "add_transaction", amount: 40, category: "nope" }],
      }),
    );
    expect(steps[0].ok).toBe(false);
  });

  it("plans an amount correction, naming both the old and new figure", async () => {
    const env = fakeEnv({ transactions: txns });
    const steps = await planBatch(
      env,
      normalizeBatch({
        actions: [
          { action: "set_transaction_amount", selector_kind: "amount", amount: 84, new_amount: 48.6 },
        ],
      }),
    );
    expect(steps[0].ok).toBe(true);
    expect(steps[0].text).toContain("STARBUCKS");
    expect(steps[0].text).toContain("$84.00");
    expect(steps[0].text).toContain("$48.60");
  });

  it("rejects an amount correction with no new amount", async () => {
    const env = fakeEnv({ transactions: txns });
    const steps = await planBatch(
      env,
      normalizeBatch({
        actions: [{ action: "set_transaction_amount", selector_kind: "last", new_amount: 0 }],
      }),
    );
    expect(steps[0].ok).toBe(false);
    expect(steps[0].text).toContain("No new amount");
  });

  // The identifying amount and the replacement amount must not collapse into
  // one another — that would silently rewrite the wrong figure.
  it("keeps the identifying amount separate from the new amount", () => {
    const [i] = normalizeBatch({
      actions: [
        { action: "set_transaction_amount", selector_kind: "amount", amount: 84, new_amount: 48.6 },
      ],
    });
    expect(i.amount).toBe(84);
    expect(i.newAmount).toBe(48.6);
  });

  it("correcting an amount then moving it targets different transactions", async () => {
    const env = fakeEnv({
      categories: [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }],
      transactions: txns,
    });
    const steps = await planBatch(
      env,
      normalizeBatch({
        actions: [
          { action: "set_transaction_amount", selector_kind: "last", new_amount: 210 },
          { action: "move_transaction", category: "gift", selector_kind: "last" },
        ],
      }),
    );
    expect(steps.map((s) => s.ok)).toEqual([true, true]);
    expect(steps[0].text).toContain("TOP GOLF BAY RESERVA");
    expect(steps[1].text).toContain("STARBUCKS");
  });

  it("reports the step that has no matching transaction", async () => {
    const env = fakeEnv({
      categories: [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }],
      transactions: txns,
    });
    const steps = await planBatch(
      env,
      normalizeBatch({
        actions: [{ action: "move_transaction", category: "gift", selector_kind: "amount", amount: 999 }],
      }),
    );
    expect(steps[0].ok).toBe(false);
    expect(steps[0].text).toContain("No transaction");
  });
});

// The one-line summary can read plausibly while a single field is quietly
// wrong, so the confirmation spells the parse out. These assert the fields a
// misparse would land in.
describe("describeIntent", () => {
  const view = (raw: any) => describeIntent(normalizeBatch({ actions: [raw] })[0], "USD");
  const asMap = (raw: any) => Object.fromEntries(view(raw).fields);

  it("titles each action in plain English, not its identifier", () => {
    expect(view({ action: "add_transaction", amount: 1 }).title).toBe("Add transaction");
    expect(view({ action: "set_transaction_amount" }).title).toBe("Correct amount");
    expect(view({ action: "create_category" }).title).toBe("New budget envelope");
  });

  it("describes a manual transaction field by field", () => {
    expect(asMap({ action: "add_transaction", amount: 12, merchant: "lunch", days_ago: 1 })).toEqual({
      Amount: "$12.00",
      Merchant: "lunch",
      When: "Yesterday",
      Budget: "Main budget",
    });
  });

  it("spells out relative dates", () => {
    const when = (d: number) => asMap({ action: "add_transaction", amount: 1, days_ago: d }).When;
    expect(when(0)).toBe("Today");
    expect(when(1)).toBe("Yesterday");
    expect(when(3)).toBe("3 days ago");
  });

  it("says how the transaction was picked", () => {
    const which = (raw: any) => asMap({ action: "move_transaction", category: "gift", ...raw })["Which charge"];
    expect(which({ selector_kind: "last" })).toBe("Most recent charge");
    expect(which({ selector_kind: "amount", amount: 200 })).toBe("The $200.00 charge");
    expect(which({ selector_kind: "merchant", selector_value: "TOP GOLF" })).toContain("TOP GOLF");
  });

  // The distinction that matters most: which transaction vs what it becomes.
  it("keeps the identifying amount distinct from the replacement", () => {
    expect(
      asMap({ action: "set_transaction_amount", selector_kind: "amount", amount: 84, new_amount: 48.6 }),
    ).toEqual({ "Which charge": "The $84.00 charge", "New amount": "$48.60" });
  });

  it("describes a new envelope with its reset cadence", () => {
    expect(
      asMap({
        action: "create_category",
        category: "gift",
        category_label: "Yearly gift budget",
        amount: 1200,
        period: "yearly",
      }),
    ).toEqual({ Name: "Yearly gift budget", Limit: "$1,200.00", Resets: "Yearly" });
  });

  it("distinguishes a category budget from the main one", () => {
    expect(asMap({ action: "set_budget", amount: 400 }).Budget).toBe("Main budget");
    expect(asMap({ action: "set_budget", amount: 400, category: "gift" }).Budget).toBe("gift");
  });
});

describe("executeBatch", () => {
  const env = () =>
    fakeEnv({
      categories: [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }],
      transactions: [{ id: 9, amount: 200, merchant: "TOP GOLF" }],
    });

  it("offers a confirmation for a valid batch", async () => {
    const reply = await executeBatch(
      env(),
      normalizeBatch({ actions: [{ action: "move_transaction", category: "gift", selector_kind: "last" }] }),
    );
    expect(reply.confirmToken).toBeTruthy();
    expect(reply.text).toContain("<b>Move transaction</b>");
    expect(reply.text).toContain("Most recent charge");
  });

  // Validate upfront: one broken step blocks everything, so a partly understood
  // message never half-applies.
  it("blocks the whole batch when any step is invalid", async () => {
    const reply = await executeBatch(
      env(),
      normalizeBatch({
        actions: [
          { action: "move_transaction", category: "gift", selector_kind: "last" },
          { action: "move_transaction", category: "nope", selector_kind: "last" },
        ],
      }),
    );
    expect(reply.confirmToken).toBeUndefined();
    expect(reply.text).toContain("haven't done any of it");
  });

  it("numbers a multi-step plan", async () => {
    const reply = await executeBatch(
      env(),
      normalizeBatch({
        actions: [
          { action: "set_budget", amount: 400 },
          { action: "move_transaction", category: "gift", selector_kind: "last" },
        ],
      }),
    );
    expect(reply.confirmToken).toBeTruthy();
    expect(reply.text).toContain("Confirm these 2 changes?");
    expect(reply.text).toContain("<b>1. Set budget</b>");
    expect(reply.text).toContain("<b>2. Move transaction</b>");
  });

  // Regression: a single action should still read as one line, not a list of one.
  it("keeps a single action unnumbered", async () => {
    const reply = await executeBatch(
      env(),
      normalizeBatch({ actions: [{ action: "set_budget", amount: 400 }] }),
    );
    expect(reply.text).toContain("Confirm this?");
    expect(reply.text).not.toContain("1.");
  });

  it("spells out the parsed fields under every confirmation", async () => {
    const reply = await executeBatch(
      env(),
      normalizeBatch({ actions: [{ action: "set_budget", amount: 400 }] }),
    );
    expect(reply.text).toContain("<b>Set budget</b>");
    expect(reply.text).toContain("Main budget");
    expect(reply.text).toContain("$400.00");
    expect(reply.text).not.toContain("set_budget(");
  });

  it("numbers and describes each step of a batch", async () => {
    const reply = await executeBatch(
      env(),
      normalizeBatch({
        actions: [
          { action: "add_transaction", amount: 12, merchant: "lunch" },
          { action: "move_transaction", category: "gift", selector_kind: "last" },
        ],
      }),
    );
    expect(reply.text).toContain("Confirm these 2 changes?");
    expect(reply.text).toContain("<b>1. Add transaction</b>");
    expect(reply.text).toContain("<b>2. Move transaction</b>");
    expect(reply.text).toContain("Most recent charge");
  });

  // A rejected step is exactly when the parse needs to be visible.
  it("shows the parsed fields when a step is rejected", async () => {
    const reply = await executeBatch(
      env(),
      normalizeBatch({ actions: [{ action: "add_transaction", merchant: "water heater" }] }),
    );
    expect(reply.confirmToken).toBeUndefined();
    expect(reply.text).toContain("No amount");
    expect(reply.text).toContain("<b>Add transaction</b>");
    expect(reply.text).toContain("water heater");
  });

  it("plans the full water-heater phrasing end to end", async () => {
    const reply = await executeBatch(
      env(),
      normalizeBatch({
        actions: [
          {
            action: "add_transaction",
            amount: 166.67,
            merchant: "water heater",
            category: "gift",
          },
        ],
      }),
    );
    expect(reply.confirmToken).toBeTruthy();
    expect(reply.text).toContain("$166.67");
    expect(reply.text).toContain("water heater");
    expect(reply.text).toContain("gift");
  });

  it("escapes a merchant name that would otherwise break the markup", async () => {
    const reply = await executeBatch(
      env(),
      normalizeBatch({
        actions: [{ action: "add_transaction", amount: 5, merchant: "Bob & <b>Sons</b>" }],
      }),
    );
    expect(reply.text).toContain("Bob &amp; &lt;b&gt;Sons&lt;/b&gt;");
  });
});

describe("period offsets", () => {
  // 2026-07-29 is a Wednesday; its week starts Monday 2026-07-27.
  const now = new Date("2026-07-29T10:00:00Z");

  it("walks back whole weeks", () => {
    expect(periodStartAt("weekly", 0, now).toISOString().slice(0, 10)).toBe("2026-07-27");
    expect(periodStartAt("weekly", 1, now).toISOString().slice(0, 10)).toBe("2026-07-20");
    expect(periodStartAt("weekly", 3, now).toISOString().slice(0, 10)).toBe("2026-07-06");
  });

  it("walks back months and years", () => {
    expect(periodStartAt("monthly", 1, now).toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(periodStartAt("yearly", 1, now).toISOString().slice(0, 10)).toBe("2025-01-01");
  });

  it("crosses a year boundary going back by month", () => {
    const jan = new Date("2026-01-15T00:00:00Z");
    expect(periodStartAt("monthly", 2, jan).toISOString().slice(0, 10)).toBe("2025-11-01");
  });

  it("treats a negative offset as the current period", () => {
    expect(periodStartAt("weekly", -5, now).toISOString()).toBe(
      periodStartAt("weekly", 0, now).toISOString(),
    );
  });

  // The range must be half-open, or a transaction at midnight Monday lands in
  // two weeks at once.
  it("ends a period exactly where the next begins", () => {
    const start = periodStartAt("weekly", 1, now);
    expect(periodEnd("weekly", start).toISOString()).toBe(periodStartAt("weekly", 0, now).toISOString());
    const m = periodStartAt("monthly", 0, now);
    expect(periodEnd("monthly", m).toISOString().slice(0, 10)).toBe("2026-08-01");
    const y = periodStartAt("yearly", 0, now);
    expect(periodEnd("yearly", y).toISOString().slice(0, 10)).toBe("2027-01-01");
  });
});

describe("scope", () => {
  const scopeOf = (raw: any) => normalizeBatch({ actions: [raw] })[0].scope;

  it("defaults to the main budget", () => {
    expect(scopeOf({ action: "list_transactions" })).toBe("main");
  });

  // Envelopes are exclusive, so "my weekly spending" must exclude filed money.
  it("keeps main scope distinct from all", () => {
    expect(scopeOf({ action: "list_transactions", scope: "all" })).toBe("all");
  });

  it("infers category scope when a category is named", () => {
    expect(scopeOf({ action: "list_transactions", category: "gift" })).toBe("category");
  });

  it("does not override an explicit all scope with a stray category", () => {
    expect(scopeOf({ action: "list_transactions", scope: "all", category: "gift" })).toBe("all");
  });

  it("clamps a wild period offset", () => {
    const off = (n: any) => normalizeBatch({ actions: [{ action: "list_transactions", period_offset: n }] })[0].periodOffset;
    expect(off(99999)).toBe(520);
    expect(off(-3)).toBe(0);
    expect(off("2")).toBe(2);
  });
});

describe("yearly period", () => {
  it("starts on Jan 1 UTC", () => {
    expect(periodStart("yearly", new Date("2026-07-27T10:00:00Z")).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("labels as the year", () => {
    expect(periodLabel("yearly", new Date("2026-01-01T00:00:00Z"))).toBe("2026");
  });

  it("recognizes all three periods and rejects others", () => {
    expect(isPeriod("weekly")).toBe(true);
    expect(isPeriod("monthly")).toBe(true);
    expect(isPeriod("yearly")).toBe(true);
    expect(isPeriod("daily")).toBe(false);
  });
});
