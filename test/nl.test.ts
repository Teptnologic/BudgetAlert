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
import { executeBatch, applyApproved, parsePending, scheduledReportText } from "../src/nl/execute";
import { periodStart, periodStartAt, periodEnd, periodLabel, daysAgo, isPeriod, type Calendar } from "../src/core/period";

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
      "remove_transaction",
      "unfile_transaction",
      "set_budget",
      "create_category",
      "delete_category",
      "set_period",
    ] as const) {
      expect(isMutating(a)).toBe(true);
    }
    for (const a of ["get_status", "query_spend", "list_transactions", "report", "unknown"] as const) {
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
  config?: Record<string, unknown>;
  categories?: { id: number; name: string; label: string; amount: number; period: string }[];
  transactions?: {
    id: number;
    amount: number;
    merchant: string | null;
    occurred_at?: string;
    category_id?: number | null;
  }[];
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
    ...(opts.config ?? {}), // caller overrides win
  };

  // Rows a selector query matches, newest first — `txns` is already in that
  // order. Mirrors the WHERE clauses in findTransaction/findTransactions.
  const matching = (sql: string, binds: any[]) => {
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
    // listRecent() scopes in SQL. Mirrored here so a test can actually catch a
    // listing that filters after the LIMIT instead of before it.
    if (sql.includes("WHERE category_id = ?")) {
      pool = pool.filter((t) => (t as any).category_id === binds[0]);
    }
    if (sql.includes("WHERE category_id IS NULL")) {
      pool = pool.filter((t) => ((t as any).category_id ?? null) === null);
    }
    return pool;
  };

  const writes: { sql: string; binds: any[] }[] = [];
  const DB: any = {
    // D1 runs a batch as one transaction; the stub records the same statements
    // so a test can tell a batched write from two loose ones.
    async batch(stmts: any[]) {
      for (const st of stmts) writes.push({ sql: st.__sql, binds: st.__binds, batched: true } as any);
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
    prepare(sql: string) {
      let binds: any[] = [];
      const api: any = {
        bind(...args: any[]) {
          binds = args;
          return api;
        },
        async first() {
          if (sql.includes("FROM config")) return cfg;
          if (sql.includes("COUNT(*) AS n") && sql.includes("category_id = ?")) {
            const filed = txns.filter((t) => (t as any).category_id === binds[0]);
            return { n: filed.length, total: filed.reduce((sum, t) => sum + t.amount, 0) };
          }
          // sumScope() over main / all — an unbounded total, no date range.
          if (sql.includes("COUNT(*) AS n") && sql.includes("FROM transactions")) {
            const pool = sql.includes("category_id IS NULL")
              ? txns.filter((t) => ((t as any).category_id ?? null) === null)
              : txns;
            return { n: pool.length, total: pool.reduce((sum, t) => sum + t.amount, 0) };
          }
          if (sql.includes("FROM categories")) {
            return cats.find((c) => c.name === binds[0]) ?? null;
          }
          if (sql.includes("FROM transactions")) {
            if (sql.includes("WHERE id = ?")) {
              return txns.find((t) => t.id === Number(binds[0])) ?? null;
            }
            return matching(sql, binds)[0] ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM categories")) return { results: cats };
          // findTransactions(): every match, newest first, bounded by LIMIT.
          // Matched narrowly so the GROUP BY aggregates below still reach theirs.
          if (sql.includes("ORDER BY occurred_at DESC, id DESC LIMIT ?")) {
            const limit = Number(binds[binds.length - 1]);
            return { results: matching(sql, binds).slice(0, limit) };
          }
          if (sql.includes("GROUP BY category_id")) {
            const byCat = new Map<number | null, { category_id: number | null; n: number; total: number }>();
            for (const t of txns) {
              const key = (t as any).category_id ?? null;
              const row = byCat.get(key) ?? { category_id: key, n: 0, total: 0 };
              row.n += 1;
              row.total += t.amount;
              byCat.set(key, row);
            }
            return { results: [...byCat.values()] };
          }
          if (sql.includes("GROUP BY merchant")) {
            const byMerchant = new Map<string | null, { merchant: string | null; n: number; total: number }>();
            for (const t of txns) {
              const row = byMerchant.get(t.merchant) ?? { merchant: t.merchant, n: 0, total: 0 };
              row.n += 1;
              row.total += t.amount;
              byMerchant.set(t.merchant, row);
            }
            return { results: [...byMerchant.values()].sort((a, b) => b.total - a.total) };
          }
          return { results: [] };
        },
        async run() {
          writes.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
      };
      Object.defineProperty(api, "__sql", { get: () => sql });
      Object.defineProperty(api, "__binds", { get: () => binds });
      return api;
    },
  };
  return { DB, writes };
}

describe("planBatch projection", () => {
  const txns = [
    // 04:00Z on the 23rd is 21:00 on the 22nd in US Pacific — the confirmation
    // must show the local day, as the history listing does.
    { id: 9, amount: 200, merchant: "TOP GOLF BAY RESERVA", occurred_at: "2026-07-23T04:00:00.000Z" },
    { id: 8, amount: 84, merchant: "STARBUCKS", occurred_at: "2026-07-21T17:30:00.000Z" },
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
    expect(view({ action: "remove_transaction" }).title).toBe("Remove transaction");
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

/* ---------------------------------------------------------------- removal */

// Deleting is the only action with nothing to undo it, so it gets its own
// coverage: that it resolves like the other selector actions, and that the
// confirmation names the row it landed on rather than just the selector.
describe("remove_transaction", () => {
  // Typed rather than inferred so a fixture may omit the date, which is the
  // "still resolves a row that has no usable date" case below.
  type Fixture = { id: number; amount: number; merchant: string | null; occurred_at?: string };
  const txns: Fixture[] = [
    { id: 9, amount: 200, merchant: "TOP GOLF BAY RESERVA", occurred_at: "2026-07-23T04:00:00.000Z" },
    { id: 8, amount: 84, merchant: "STARBUCKS", occurred_at: "2026-07-21T17:30:00.000Z" },
  ];
  const plan = (raw: any, transactions: Fixture[] = txns) =>
    planBatch(fakeEnv({ transactions }), normalizeBatch({ actions: [raw] }));

  it("counts as a write, so it can never be answered without a tap", () => {
    expect(isMutating("remove_transaction")).toBe(true);
    expect(batchMutates(normalizeBatch({ actions: [{ action: "remove_transaction" }] }))).toBe(true);
  });

  it("plans a removal against the most recent charge", async () => {
    const [step] = await plan({ action: "remove_transaction", selector_kind: "last" });
    expect(step.ok).toBe(true);
    expect(step.text).toContain("Remove $200.00");
    expect(step.text).toContain("TOP GOLF BAY RESERVA");
  });

  it("picks a charge by amount", async () => {
    const [step] = await plan({ action: "remove_transaction", selector_kind: "amount", amount: 84 });
    expect(step.ok).toBe(true);
    expect(step.text).toContain("STARBUCKS");
  });

  it("picks a charge by merchant", async () => {
    const [step] = await plan({
      action: "remove_transaction",
      selector_kind: "merchant",
      selector_value: "starbucks",
    });
    expect(step.ok).toBe(true);
    expect(step.text).toContain("$84.00");
  });

  // The point of the whole feature's safety story: "Most recent charge" does not
  // say WHICH charge, and there is no undo, so the plan resolves it for the user.
  it("names the row the selector landed on, with its local date", async () => {
    const [step] = await plan({ action: "remove_transaction", selector_kind: "last" });
    const fields = Object.fromEntries(step.view.fields);
    expect(fields["Which charge"]).toBe("Most recent charge");
    expect(fields["Removing"]).toBe("$200.00 — TOP GOLF BAY RESERVA (07-22)");
  });

  it("still resolves a row that has no usable date", async () => {
    const [step] = await plan({ action: "remove_transaction", selector_kind: "last" }, [
      { id: 1, amount: 5, merchant: "CASH" },
    ]);
    expect(step.ok).toBe(true);
    expect(Object.fromEntries(step.view.fields)["Removing"]).toBe("$5.00 — CASH");
  });

  it("refuses when it can't tell which charge was meant", async () => {
    const [step] = await plan({ action: "remove_transaction", selector_kind: "none" });
    expect(step.ok).toBe(false);
    expect(step.text).toContain("Couldn't tell which charge");
  });

  it("reports a selector that matches nothing", async () => {
    const [step] = await plan({ action: "remove_transaction", selector_kind: "amount", amount: 999 });
    expect(step.ok).toBe(false);
    expect(step.text).toContain("No transaction matching $999.00");
  });

  // Same claim tracking as the other selector actions: without it both steps
  // resolve to the newest row and one deletion silently targets it twice.
  it("does not resolve two removals to the same transaction", async () => {
    const steps = await planBatch(
      fakeEnv({ transactions: txns }),
      normalizeBatch({
        actions: [
          { action: "remove_transaction", selector_kind: "last" },
          { action: "remove_transaction", selector_kind: "last" },
        ],
      }),
    );
    expect(steps.map((s) => s.ok)).toEqual([true, true]);
    expect(steps[0].text).toContain("TOP GOLF BAY RESERVA");
    expect(steps[1].text).toContain("STARBUCKS");
  });

  it("keeps a removal and a move on separate rows", async () => {
    const steps = await planBatch(
      fakeEnv({
        categories: [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }],
        transactions: txns,
      }),
      normalizeBatch({
        actions: [
          { action: "remove_transaction", selector_kind: "last" },
          { action: "move_transaction", category: "gift", selector_kind: "last" },
        ],
      }),
    );
    expect(steps.map((s) => s.ok)).toEqual([true, true]);
    expect(steps[0].text).toContain("TOP GOLF BAY RESERVA");
    expect(steps[1].text).toContain("STARBUCKS");
  });

  it("stages behind a confirmation instead of acting", async () => {
    const reply = await executeBatch(
      fakeEnv({ transactions: txns }),
      normalizeBatch({ actions: [{ action: "remove_transaction", selector_kind: "last" }] }),
    );
    expect(reply.stage).toBeTruthy();
    expect(reply.text).toContain("Confirm this?");
    expect(reply.text).toContain("<b>Remove transaction</b>");
    expect(reply.text).toContain("TOP GOLF BAY RESERVA (07-22)");
  });

  // A merchant name is user-supplied text and reaches the confirmation twice —
  // once via the selector, once via the resolved row. Both must be escaped.
  it("escapes a merchant name in the resolved field", async () => {
    const reply = await executeBatch(
      fakeEnv({ transactions: [{ id: 1, amount: 9, merchant: "A & B <b>", occurred_at: "2026-07-22T19:00:00.000Z" }] }),
      normalizeBatch({ actions: [{ action: "remove_transaction", selector_kind: "last" }] }),
    );
    expect(reply.text).toContain("A &amp; B &lt;b&gt;");
    expect(reply.text).not.toContain("A & B <b>");
  });
});

/* ------------------------------------------------- quarters and reporting */

describe("quarterly periods", () => {
  const cal: Calendar = { timeZone: "America/Los_Angeles", weekStartsOn: 0 };
  const at = (offset: number, now: string) =>
    periodStartAt("quarterly", offset, new Date(now), cal);

  it("is a recognized period", () => {
    expect(isPeriod("quarterly")).toBe(true);
  });

  it("snaps to the quarter the date sits in", () => {
    // Every month of Q3 resolves to the same July 1 boundary.
    for (const d of ["2026-07-01T12:00:00Z", "2026-08-14T12:00:00Z", "2026-09-30T12:00:00Z"]) {
      expect(at(0, d).toISOString()).toBe(new Date("2026-07-01T07:00:00Z").toISOString());
    }
  });

  it("puts each quarter's first day in its own quarter", () => {
    expect(periodLabel("quarterly", at(0, "2026-01-01T12:00:00Z"), cal)).toBe("Q1 2026");
    expect(periodLabel("quarterly", at(0, "2026-04-01T12:00:00Z"), cal)).toBe("Q2 2026");
    expect(periodLabel("quarterly", at(0, "2026-07-01T12:00:00Z"), cal)).toBe("Q3 2026");
    expect(periodLabel("quarterly", at(0, "2026-10-01T12:00:00Z"), cal)).toBe("Q4 2026");
  });

  it("walks back quarters across a year boundary", () => {
    const now = "2026-02-10T12:00:00Z"; // Q1 2026
    expect(periodLabel("quarterly", at(1, now), cal)).toBe("Q4 2025");
    expect(periodLabel("quarterly", at(2, now), cal)).toBe("Q3 2025");
    expect(periodLabel("quarterly", at(4, now), cal)).toBe("Q1 2025");
  });

  it("ends exactly where the next quarter begins", () => {
    const start = at(0, "2026-08-14T12:00:00Z");
    expect(periodEnd("quarterly", start, cal).toISOString()).toBe(
      at(0, "2026-10-05T12:00:00Z").toISOString(),
    );
  });

  it("lands on local midnight, not UTC midnight", () => {
    // Q4 begins Oct 1 at 00:00 Pacific = 07:00 UTC (PDT is still in effect).
    expect(at(0, "2026-11-05T12:00:00Z").toISOString()).toBe("2026-10-01T07:00:00.000Z");
  });

  // A Q3 boundary is a DST-free stretch, but Q1/Q4 straddle both changes.
  it("keeps whole quarters adjacent across daylight saving", () => {
    const q1 = at(0, "2026-02-10T12:00:00Z");
    expect(periodEnd("quarterly", q1, cal).toISOString()).toBe(
      at(0, "2026-05-10T12:00:00Z").toISOString(),
    );
  });
});

// "@bot show all of my gift spending" — an envelope named, no date range. It
// used to come back empty or as unrelated spending; these pin down why.
describe("all-time envelope history", () => {
  // A gift envelope with real history, none of it recent: every gift charge is
  // older than the main budget's newest rows. This is the shape that broke.
  const txns = [
    { id: 6, amount: 40, merchant: "SAFEWAY", category_id: null, occurred_at: "2026-09-05T19:00:00.000Z" },
    { id: 5, amount: 30, merchant: "SAFEWAY", category_id: null, occurred_at: "2026-09-04T19:00:00.000Z" },
    { id: 4, amount: 20, merchant: "SAFEWAY", category_id: null, occurred_at: "2026-09-03T19:00:00.000Z" },
    { id: 3, amount: 10, merchant: "SAFEWAY", category_id: null, occurred_at: "2026-09-02T19:00:00.000Z" },
    { id: 2, amount: 300, merchant: "GIFT SHOP", category_id: 1, occurred_at: "2026-02-10T19:00:00.000Z" },
    { id: 1, amount: 150, merchant: "TOY STORE", category_id: 1, occurred_at: "2026-01-05T19:00:00.000Z" },
  ];
  const cats = [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }];
  const run = (raw: any) =>
    executeBatch(
      fakeEnv({ transactions: txns, categories: cats }),
      normalizeBatch({ actions: [{ action: "list_transactions", ...raw }] }),
    );

  it("lists an envelope's whole history, not one calendar period", async () => {
    const reply = await run({ scope: "category", category: "gift", window: "all" });
    expect(reply.text).toContain("GIFT SHOP");
    expect(reply.text).toContain("TOY STORE");
    expect(reply.text).toContain("all time");
    expect(reply.text).toContain("$450.00");
  });

  it("keeps unrelated spending out of an envelope's history", async () => {
    const reply = await run({ scope: "category", category: "gift", window: "all" });
    expect(reply.text).not.toContain("SAFEWAY");
  });

  // The regression: the recent-N listing fetched the newest 50 rows across the
  // whole account and filtered to the envelope afterwards, so an envelope whose
  // charges all fall outside that window reported "Nothing recorded" despite
  // having history. It takes more than 50 rows to reproduce — the filter has to
  // be pushed past the cap, not merely applied in the wrong order.
  it("finds envelope charges older than the newest 50 rows overall", async () => {
    const buried = [
      ...Array.from({ length: 60 }, (_, i) => ({
        id: 1000 + i,
        amount: 10,
        merchant: "SAFEWAY",
        category_id: null,
        occurred_at: `2026-09-${String(60 - i).padStart(2, "0")}T19:00:00.000Z`.replace(
          /-(\d\d)T/,
          (_m, d) => `-${String(Math.max(1, Math.min(30, Number(d)))).padStart(2, "0")}T`,
        ),
      })),
      { id: 2, amount: 300, merchant: "GIFT SHOP", category_id: 1, occurred_at: "2026-02-10T19:00:00.000Z" },
      { id: 1, amount: 150, merchant: "TOY STORE", category_id: 1, occurred_at: "2026-01-05T19:00:00.000Z" },
    ];
    const reply = await executeBatch(
      fakeEnv({ transactions: buried, categories: cats }),
      normalizeBatch({
        actions: [
          { action: "list_transactions", scope: "category", category: "gift", window: "none", limit: 5 },
        ],
      }),
    );
    expect(reply.text).not.toContain("Nothing recorded");
    expect(reply.text).toContain("GIFT SHOP");
    expect(reply.text).toContain("TOY STORE");
  });

  it("still scopes a plain recent listing to the main budget", async () => {
    const reply = await run({ window: "none", limit: 5 });
    expect(reply.text).toContain("SAFEWAY");
    expect(reply.text).not.toContain("GIFT SHOP");
  });

  it("answers an all-time spend question over the whole history", async () => {
    const reply = await executeBatch(
      fakeEnv({ transactions: txns, categories: cats }),
      normalizeBatch({
        actions: [{ action: "query_spend", category: "gift", scope: "category", window: "all" }],
      }),
    );
    expect(reply.text).toContain("All time");
    expect(reply.text).toContain("$450.00");
  });

  // A report is by construction one period's summary, so 'all' has no meaning
  // there. It must not silently degrade to a week.
  it("reads an all-time report as the year rather than a week", () => {
    const i = normalizeBatch({ actions: [{ action: "report", window: "all" }] })[0];
    expect(i.window).toBe("year");
  });

  it("leaves 'all' alone on a listing", () => {
    const i = normalizeBatch({ actions: [{ action: "list_transactions", window: "all" }] })[0];
    expect(i.window).toBe("all");
  });
});

describe("report", () => {
  const txns = [
    { id: 3, amount: 200, merchant: "COSTCO", category_id: null, occurred_at: "2026-07-05T19:00:00.000Z" },
    { id: 2, amount: 100, merchant: "COSTCO", category_id: null, occurred_at: "2026-07-06T19:00:00.000Z" },
    { id: 1, amount: 50, merchant: "GIFT SHOP", category_id: 1, occurred_at: "2026-07-07T19:00:00.000Z" },
  ];
  const cats = [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }];
  const run = (raw: any, config?: Record<string, unknown>) =>
    executeBatch(
      fakeEnv({ transactions: txns, categories: cats, config }),
      normalizeBatch({ actions: [{ action: "report", ...raw }] }),
    );

  it("is a read — answered outright, never staged for a tap", async () => {
    const reply = await run({ window: "quarter" });
    expect(reply.stage).toBeUndefined();
  });

  it("separates main-budget spend from envelope spend", async () => {
    const reply = await run({ window: "quarter" });
    expect(reply.text).toContain("$300.00"); // main only
    expect(reply.text).toContain("Gift");
    expect(reply.text).toContain("$350.00"); // everything together
  });

  it("groups repeat merchants and ranks them", async () => {
    const reply = await run({ window: "quarter" });
    expect(reply.text).toContain("$300.00 — COSTCO (2×)");
    expect(reply.text.indexOf("COSTCO")).toBeLessThan(reply.text.indexOf("GIFT SHOP"));
  });

  // "$300 of $500" is true for a week and nonsense for a quarter on a weekly
  // budget, so the limit is only shown when the cadences actually match.
  it("compares against the budget only when the cadences match", async () => {
    const weekly = await run({ window: "week" }, { period: "weekly" });
    expect(weekly.text).toContain("of $500.00");

    const quarterly = await run({ window: "quarter" }, { period: "weekly" });
    expect(quarterly.text).not.toContain("of $500.00");
    expect(quarterly.text).toContain("budget resets weekly");
  });

  it("labels the period it covers", async () => {
    const reply = await run({ window: "quarter" });
    expect(reply.text).toMatch(/Q[1-4] \d{4}/);
  });

  // The cron path must not post "Nothing recorded" to the group every quarter,
  // but someone who typed /report still deserves an answer.
  it("stays silent for the cron on an empty period, but answers a direct ask", async () => {
    const quiet = fakeEnv({ transactions: [] });
    expect(await scheduledReportText(quiet, "quarter", 1)).toBeNull();

    const asked = await executeBatch(
      quiet,
      normalizeBatch({ actions: [{ action: "report", window: "quarter", period_offset: 1 }] }),
    );
    expect(asked.text).toContain("Nothing recorded");
  });

  it("returns the same report the command does when there is spending", async () => {
    const env = fakeEnv({ transactions: txns, categories: cats });
    const scheduled = await scheduledReportText(env, "quarter", 0);
    const asked = await executeBatch(
      env,
      normalizeBatch({ actions: [{ action: "report", window: "quarter", period_offset: 0 }] }),
    );
    expect(scheduled).toBe(asked.text);
  });

  it("says so plainly when a period is empty", async () => {
    const reply = await executeBatch(
      fakeEnv({ transactions: [] }),
      normalizeBatch({ actions: [{ action: "report", window: "year" }] }),
    );
    expect(reply.text).toContain("Nothing recorded");
  });
});

/* ------------------------------------------------ unfiling and envelope rm */

describe("unfile_transaction", () => {
  const cats = [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }];
  const filed = [
    { id: 9, amount: 200, merchant: "TOP GOLF", category_id: 1, occurred_at: "2026-07-23T04:00:00.000Z" },
  ];

  it("returns a filed charge to the main budget, naming the envelope it leaves", async () => {
    const [step] = await planBatch(
      fakeEnv({ categories: cats, transactions: filed }),
      normalizeBatch({ actions: [{ action: "unfile_transaction", selector_kind: "last" }] }),
    );
    expect(step.ok).toBe(true);
    const fields = Object.fromEntries(step.view.fields);
    expect(fields["Move into"]).toBe("Main budget");
    expect(fields["Returning"]).toBe("$200.00 — TOP GOLF (07-22)");
    expect(fields["Out of"]).toBe("Gift");
  });

  // Not a failure: erroring here would block every other step in the batch.
  it("treats an already-unfiled charge as a no-op, not an error", async () => {
    const [step] = await planBatch(
      fakeEnv({ transactions: [{ id: 9, amount: 200, merchant: "TOP GOLF", category_id: null }] }),
      normalizeBatch({ actions: [{ action: "unfile_transaction", selector_kind: "last" }] }),
    );
    expect(step.ok).toBe(true);
    expect(step.text).toContain("already there");
  });

  it("refuses without a selector", async () => {
    const [step] = await planBatch(
      fakeEnv({ transactions: filed }),
      normalizeBatch({ actions: [{ action: "unfile_transaction", selector_kind: "none" }] }),
    );
    expect(step.ok).toBe(false);
  });

  // A no-op step still claims its row, or "move the last two back" reports on
  // the same charge twice and silently leaves the second one filed.
  it("walks two rows when asked twice, even where the first is a no-op", async () => {
    const steps = await planBatch(
      fakeEnv({
        categories: cats,
        transactions: [
          { id: 9, amount: 200, merchant: "ALREADY MAIN", category_id: null },
          { id: 8, amount: 50, merchant: "IN GIFT", category_id: 1 },
        ],
      }),
      normalizeBatch({
        actions: [
          { action: "unfile_transaction", selector_kind: "last" },
          { action: "unfile_transaction", selector_kind: "last" },
        ],
      }),
    );
    expect(steps[0].text).toContain("already there");
    expect(steps[1].text).toContain("IN GIFT");
  });
});

describe("delete_category", () => {
  const cats = [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }];
  const filed = [
    { id: 9, amount: 200, merchant: "TOP GOLF", category_id: 1 },
    { id: 8, amount: 50, merchant: "GIFT SHOP", category_id: 1 },
  ];
  const plan = (raw: any, transactions = filed) =>
    planBatch(
      fakeEnv({ categories: cats, transactions }),
      normalizeBatch({ actions: [{ action: "delete_category", category: "gift", ...raw }] }),
    );

  // The whole point of the flag: a plain deletion must never destroy spending.
  it("keeps the spending by default, returning it to the main budget", async () => {
    const [step] = await plan({});
    expect(step.ok).toBe(true);
    const fields = Object.fromEntries(step.view.fields);
    expect(fields["Its charges"]).toBe("Return to main budget");
    expect(fields["Affects"]).toBe("2 charges ($250.00) return to the main budget");
  });

  it("destroys the spending only when the flag is explicitly set", async () => {
    const [step] = await plan({ purge_transactions: true });
    const fields = Object.fromEntries(step.view.fields);
    expect(fields["Its charges"]).toBe("Deleted too");
    expect(fields["Affects"]).toBe("2 charges ($250.00) deleted with it");
  });

  it("never reads a missing or junk flag as consent to destroy", () => {
    for (const raw of [undefined, null, "", 0, "yes", "TRUE-ish", {}]) {
      expect(normalizeIntent({ action: "delete_category", purge_transactions: raw }).purgeTransactions).toBe(false);
    }
    expect(normalizeIntent({ action: "delete_category", purge_transactions: true }).purgeTransactions).toBe(true);
    // pending_actions round trips through JSON, which can stringify the flag.
    expect(normalizeIntent({ action: "delete_category", purgeTransactions: "true" }).purgeTransactions).toBe(true);
  });

  it("says plainly when there is nothing filed to it", async () => {
    const [step] = await plan({}, []);
    expect(Object.fromEntries(step.view.fields)["Affects"]).toBe("No charges filed to it");
  });

  it("rejects an envelope that doesn't exist", async () => {
    const [step] = await planBatch(
      fakeEnv({ categories: cats }),
      normalizeBatch({ actions: [{ action: "delete_category", category: "nope" }] }),
    );
    expect(step.ok).toBe(false);
    expect(step.text).toContain("No budget called");
  });

  // The projection must show the envelope gone, or a later step plans against
  // a world that will not exist by the time it runs.
  it("blocks a move into an envelope an earlier step deletes", async () => {
    const steps = await planBatch(
      fakeEnv({ categories: cats, transactions: filed }),
      normalizeBatch({
        actions: [
          { action: "delete_category", category: "gift" },
          { action: "move_transaction", category: "gift", selector_kind: "last" },
        ],
      }),
    );
    expect(steps.map((s) => s.ok)).toEqual([true, false]);
    expect(steps[1].text).toContain("No budget called");
  });

  it("stages behind a confirmation stating the consequence", async () => {
    const reply = await executeBatch(
      fakeEnv({ categories: cats, transactions: filed }),
      normalizeBatch({ actions: [{ action: "delete_category", category: "gift" }] }),
    );
    expect(reply.stage).toBeTruthy();
    expect(reply.text).toContain("<b>Delete budget envelope</b>");
    expect(reply.text).toContain("return to the main budget");
  });
});

/* ------------------------------------------------------------ apply paths */

// Everything above stops at the confirmation. These run the code that fires
// AFTER the tap — the statements that actually destroy or move data — because a
// plan that reads correctly and a write that does the right thing are two
// different claims, and only the second one costs you transaction history.
describe("applying an approved batch", () => {
  const cats = [{ id: 1, name: "gift", label: "Gift", amount: 1200, period: "yearly" }];
  const filed = [
    { id: 9, amount: 200, merchant: "TOP GOLF", category_id: 1 },
    { id: 8, amount: 50, merchant: "GIFT SHOP", category_id: 1 },
  ];
  const apply = async (raw: any, opts: any = {}) => {
    const env = fakeEnv({ categories: cats, transactions: filed, ...opts });
    const text = await applyApproved(env, normalizeBatch({ actions: [raw] }));
    return { text, writes: (env as any).writes as { sql: string; binds: any[] }[] };
  };
  // Generic so the caller keeps `binds` on the rows it gets back.
  const statements = <T extends { sql: string }>(writes: T[], needle: string) =>
    writes.filter((w) => w.sql.includes(needle));

  it("removing a charge deletes exactly that row", async () => {
    const { text, writes } = await apply({ action: "remove_transaction", selector_kind: "last" });
    const dels = statements(writes, "DELETE FROM transactions");
    expect(dels).toHaveLength(1);
    expect(dels[0].binds).toEqual([9]); // the newest, not the other one
    expect(text).toContain("Removed $200.00");
  });

  it("unfiling clears the category instead of deleting anything", async () => {
    const { text, writes } = await apply({ action: "unfile_transaction", selector_kind: "last" });
    expect(statements(writes, "DELETE FROM transactions")).toHaveLength(0);
    const upd = statements(writes, "SET category_id = ?");
    expect(upd).toHaveLength(1);
    expect(upd[0].binds).toEqual([null, 9]);
    expect(text).toContain("Returned");
  });

  // The flag's whole job. If this ever inverts, a plain "delete the gift budget"
  // silently destroys real spending records.
  it("deleting an envelope keeps its charges by default", async () => {
    const { text, writes } = await apply({ action: "delete_category", category: "gift" });
    expect(statements(writes, "DELETE FROM transactions")).toHaveLength(0);
    expect(statements(writes, "UPDATE transactions SET category_id = NULL")).toHaveLength(1);
    expect(statements(writes, "DELETE FROM categories")).toHaveLength(1);
    expect(text).toContain("returned to the main budget");
  });

  it("deleting an envelope destroys its charges only with the flag", async () => {
    const { text, writes } = await apply({
      action: "delete_category",
      category: "gift",
      purge_transactions: true,
    });
    expect(statements(writes, "UPDATE transactions SET category_id = NULL")).toHaveLength(0);
    expect(statements(writes, "DELETE FROM transactions")).toHaveLength(1);
    expect(statements(writes, "DELETE FROM categories")).toHaveLength(1);
    expect(text).toContain("deleted with it");
  });

  // Half-applied deletion is the failure that matters here: charges already
  // moved or destroyed while the envelope is still listed.
  it("deletes the envelope and settles its charges in one transaction", async () => {
    const { writes } = await apply({ action: "delete_category", category: "gift" });
    const parts = writes.filter(
      (w) => w.sql.includes("DELETE FROM categories") || w.sql.includes("category_id = NULL"),
    );
    expect(parts).toHaveLength(2);
    expect(parts.every((w) => (w as any).batched)).toBe(true);
  });

  it("correcting an amount writes the new figure, not the identifying one", async () => {
    const { writes } = await apply({
      action: "set_transaction_amount",
      selector_kind: "amount",
      amount: 200,
      new_amount: 48.6,
    });
    const upd = statements(writes, "SET amount = ?");
    expect(upd[0].binds).toEqual([48.6, 9]);
  });

  it("does not re-target one row for two steps", async () => {
    const env = fakeEnv({ categories: cats, transactions: filed });
    await applyApproved(
      env,
      normalizeBatch({
        actions: [
          { action: "remove_transaction", selector_kind: "last" },
          { action: "remove_transaction", selector_kind: "last" },
        ],
      }),
    );
    const dels = ((env as any).writes as { sql: string; binds: any[] }[]).filter((w) =>
      w.sql.includes("DELETE FROM transactions"),
    );
    expect(dels.map((d) => d.binds[0])).toEqual([9, 8]);
  });

  // A step whose target vanished between the tap and the write must not take
  // the rest of the batch down with it.
  it("reports a step whose row is gone and still runs the others", async () => {
    const env = fakeEnv({ categories: cats, transactions: [] });
    const text = await applyApproved(
      env,
      normalizeBatch({
        actions: [
          { action: "remove_transaction", selector_kind: "last" },
          { action: "set_budget", amount: 400 },
        ],
      }),
    );
    expect(text).toContain("no longer there");
    expect(text).toContain("Main budget set to $400.00");
    expect(text).toContain("didn't apply");
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
    expect(reply.stage).toBeTruthy();
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
    expect(reply.stage).toBeUndefined();
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
    expect(reply.stage).toBeTruthy();
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
    expect(reply.stage).toBeUndefined();
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
    expect(reply.stage).toBeTruthy();
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

// The configured calendar: weeks begin Sunday, computed in US Pacific.
const PT: Calendar = { timeZone: "America/Los_Angeles", weekStartsOn: 0 };

// Local wall-clock rendering of an instant, for readable assertions.
const inPT = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: PT.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(d)
    .replace(",", "");

describe("period offsets (Sunday weeks, US Pacific)", () => {
  // 2026-07-29 is a Wednesday; with Sunday weeks its week starts 2026-07-26.
  const now = new Date("2026-07-29T17:00:00Z"); // 10:00 PDT

  it("starts the week on Sunday", () => {
    expect(inPT(periodStartAt("weekly", 0, now, PT))).toBe("2026-07-26 00:00");
    expect(inPT(periodStartAt("weekly", 1, now, PT))).toBe("2026-07-19 00:00");
    expect(inPT(periodStartAt("weekly", 3, now, PT))).toBe("2026-07-05 00:00");
  });

  it("keeps Sunday itself as the first day, not the last", () => {
    const sunday = new Date("2026-08-02T18:00:00Z"); // Sunday 11:00 PDT
    expect(inPT(periodStartAt("weekly", 0, sunday, PT))).toBe("2026-08-02 00:00");
  });

  it("still supports Monday weeks when configured", () => {
    const monday: Calendar = { ...PT, weekStartsOn: 1 };
    expect(inPT(periodStartAt("weekly", 0, now, monday))).toBe("2026-07-27 00:00");
  });

  it("walks back months and years", () => {
    expect(inPT(periodStartAt("monthly", 1, now, PT))).toBe("2026-06-01 00:00");
    expect(inPT(periodStartAt("yearly", 1, now, PT))).toBe("2025-01-01 00:00");
  });

  it("crosses a year boundary going back by month", () => {
    const jan = new Date("2026-01-15T20:00:00Z");
    expect(inPT(periodStartAt("monthly", 2, jan, PT))).toBe("2025-11-01 00:00");
  });

  it("treats a negative offset as the current period", () => {
    expect(periodStartAt("weekly", -5, now, PT).toISOString()).toBe(
      periodStartAt("weekly", 0, now, PT).toISOString(),
    );
  });

  // Half-open, or a transaction at local midnight Sunday lands in two weeks.
  it("ends a period exactly where the next begins", () => {
    const start = periodStartAt("weekly", 1, now, PT);
    expect(periodEnd("weekly", start, PT).toISOString()).toBe(
      periodStartAt("weekly", 0, now, PT).toISOString(),
    );
    expect(inPT(periodEnd("monthly", periodStartAt("monthly", 0, now, PT), PT))).toBe(
      "2026-08-01 00:00",
    );
    expect(inPT(periodEnd("yearly", periodStartAt("yearly", 0, now, PT), PT))).toBe(
      "2027-01-01 00:00",
    );
  });
});

describe("timezone correctness", () => {
  // The bug that motivated this: on UTC, a Saturday-evening purchase in
  // California is already Sunday and would file into the following week.
  it("keeps a Saturday-night purchase in the week it was spent", () => {
    const satNight = new Date("2026-08-02T02:00:00Z"); // Sat 19:00 PDT
    const start = periodStartAt("weekly", 0, satNight, PT);
    expect(inPT(start)).toBe("2026-07-26 00:00");
    expect(satNight >= start).toBe(true);
    expect(satNight < periodEnd("weekly", start, PT)).toBe(true);
  });

  it("puts local midnight Sunday in the new week, not the old one", () => {
    const justAfter = new Date("2026-08-02T07:00:01Z"); // 00:00:01 PDT Sunday
    expect(inPT(periodStartAt("weekly", 0, justAfter, PT))).toBe("2026-08-02 00:00");
  });

  // Week boundaries must be local midnight on both sides of a DST change, not
  // a fixed 168 hours apart.
  it("lands on local midnight across the spring-forward week", () => {
    const afterSpring = new Date("2026-03-10T19:00:00Z"); // Tue after DST starts
    for (let i = 0; i < 3; i++) {
      expect(inPT(periodStartAt("weekly", i, afterSpring, PT)).slice(-5)).toBe("00:00");
    }
    // The week containing the change is still exactly one week long, locally.
    const spanning = periodStartAt("weekly", 1, afterSpring, PT); // week of Mar 1
    expect(inPT(spanning)).toBe("2026-03-01 00:00");
    expect(inPT(periodEnd("weekly", spanning, PT))).toBe("2026-03-08 00:00");
  });

  it("lands on local midnight across the fall-back week", () => {
    const afterFall = new Date("2026-11-03T20:00:00Z");
    const spanning = periodStartAt("weekly", 0, afterFall, PT);
    expect(inPT(spanning)).toBe("2026-11-01 00:00");
    expect(inPT(periodEnd("weekly", spanning, PT))).toBe("2026-11-08 00:00");
  });

  it("resolves 'yesterday' by local date, not by subtracting 24 hours", () => {
    const early = new Date("2026-08-02T08:00:00Z"); // Sun 01:00 PDT
    expect(inPT(daysAgo(1, early, PT))).toBe("2026-08-01 00:00");
    expect(inPT(daysAgo(0, early, PT))).toBe("2026-08-02 00:00");
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
  it("starts on Jan 1, local time", () => {
    expect(inPT(periodStart("yearly", new Date("2026-07-27T17:00:00Z"), PT))).toBe("2026-01-01 00:00");
  });

  it("labels as the year", () => {
    expect(periodLabel("yearly", periodStart("yearly", new Date("2026-07-27T17:00:00Z"), PT), PT)).toBe("2026");
  });

  it("recognizes all three periods and rejects others", () => {
    expect(isPeriod("weekly")).toBe(true);
    expect(isPeriod("monthly")).toBe(true);
    expect(isPeriod("yearly")).toBe(true);
    expect(isPeriod("daily")).toBe(false);
  });
});

/* ------------------------------------------------- ambiguous selectors */

// Straight from the transcript that motivated all of this. Three $0.01 pre-auth
// holds; one merchant name is a PREFIX of another; the unrelated one is newest.
//
// What used to happen:
//   · "change FD *CA DMV 640 to $616, change FD *CA DMV 640 *SVC to $12.94"
//     resolved step 1 to the *SVC row (newest LIKE match), leaving step 2 with
//     nothing and rejecting the whole batch.
//   · Re-sent as "change FD *CA DMV 640 from $0.01 to $616", the model read
//     "from $0.01" as an AMOUNT selector, and applying re-ran it and landed on
//     the newest $0.01 row — a different merchant entirely.
const dmv = [
  { id: 20, amount: 0.01, merchant: "SLC PANDA EXPRESS 62", occurred_at: "2026-09-06T20:00:00.000Z" },
  { id: 31, amount: 0.01, merchant: "FD *CA DMV 640 *SVC", occurred_at: "2026-09-06T18:05:00.000Z" },
  { id: 30, amount: 0.01, merchant: "FD *CA DMV 640", occurred_at: "2026-09-06T18:00:00.000Z" },
];

const correct = (selector: Record<string, unknown>, newAmount: number) => ({
  action: "set_transaction_amount",
  new_amount: newAmount,
  ...selector,
});

const byMerchant = (value: string) => ({ selector_kind: "merchant", selector_value: value });

describe("selector resolution across a batch", () => {
  it("gives each of two overlapping merchant selectors its own charge", async () => {
    const steps = await planBatch(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({
        actions: [
          correct(byMerchant("FD *CA DMV 640"), 616),
          correct(byMerchant("FD *CA DMV 640 *SVC"), 12.94),
        ],
      }),
    );
    expect(steps.map((s) => s.ok)).toEqual([true, true]);
    expect(steps.map((s) => s.txnId)).toEqual([30, 31]);
  });

  // Order of mention must not decide who gets the row: the same two steps the
  // other way round still land on the same two charges.
  it("resolves the same way whichever selector is stated first", async () => {
    const steps = await planBatch(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({
        actions: [
          correct(byMerchant("FD *CA DMV 640 *SVC"), 12.94),
          correct(byMerchant("FD *CA DMV 640"), 616),
        ],
      }),
    );
    expect(steps.map((s) => s.ok)).toEqual([true, true]);
    expect(steps.map((s) => s.txnId)).toEqual([31, 30]);
  });

  // A merchant that exists under its own name is not ambiguous just because a
  // longer name contains it.
  it("prefers an exact merchant match over the row it is a prefix of", async () => {
    const steps = await planBatch(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({ actions: [correct(byMerchant("FD *CA DMV 640"), 616)] }),
    );
    expect(steps[0].ok).toBe(true);
    expect(steps[0].txnId).toBe(30);
  });

  // Where nothing matches exactly, guessing is the bug. Report the choice.
  it("reports a partial merchant match against two rows as a choice", async () => {
    const steps = await planBatch(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({ actions: [correct(byMerchant("DMV"), 616)] }),
    );
    expect(steps[0].ok).toBe(false);
    expect(steps[0].text).toContain("2 transactions matching “DMV”");
    expect(steps[0].candidates?.map((t) => t.id)).toEqual([31, 30]);
  });

  // Every pre-auth hold is $0.01, so an amount selector across three of them
  // carries no information about which was meant.
  it("reports identical amounts as a choice rather than taking the newest", async () => {
    const steps = await planBatch(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({ actions: [correct({ selector_kind: "amount", amount: 0.01 }, 616)] }),
    );
    expect(steps[0].ok).toBe(false);
    expect(steps[0].candidates?.map((t) => t.id)).toEqual([20, 31, 30]);
  });

  it("names each option in the parse it shows back", async () => {
    const steps = await planBatch(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({ actions: [correct(byMerchant("DMV"), 616)] }),
    );
    const fields = Object.fromEntries(steps[0].view.fields);
    expect(fields["Option 1"]).toBe("$0.01 — FD *CA DMV 640 *SVC (09-06)");
    expect(fields["Option 2"]).toBe("$0.01 — FD *CA DMV 640 (09-06)");
  });

  // Past a handful, a list of buttons is not an answer — ask for a better
  // selector instead of offering twelve near-identical rows.
  it("refuses to offer a choice between too many matches", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: 100 + i,
      amount: 0.01,
      merchant: `HOLD ${i}`,
      occurred_at: "2026-09-06T18:00:00.000Z",
    }));
    const steps = await planBatch(
      fakeEnv({ transactions: many }),
      normalizeBatch({ actions: [correct({ selector_kind: "amount", amount: 0.01 }, 616)] }),
    );
    expect(steps[0].ok).toBe(false);
    expect(steps[0].candidates).toBeUndefined();
    expect(steps[0].text).toContain("too many to choose from");
  });

  // 'last' means "whatever is newest that nobody else claimed", so it must not
  // take a row a named selector needs.
  it("keeps 'last' off a row a named selector already claimed", async () => {
    const steps = await planBatch(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({
        actions: [
          { action: "remove_transaction", selector_kind: "merchant", selector_value: "SLC PANDA EXPRESS 62" },
          { action: "remove_transaction", selector_kind: "last" },
        ],
      }),
    );
    expect(steps.map((s) => s.ok)).toEqual([true, true]);
    expect(steps.map((s) => s.txnId)).toEqual([20, 31]);
  });
});

describe("asking which charge", () => {
  const ask = () =>
    executeBatch(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({ actions: [correct(byMerchant("DMV"), 616)] }),
    );

  it("asks instead of refusing outright", async () => {
    const reply = await ask();
    expect(reply.text).toContain("Which charge did you mean?");
    expect(reply.text).not.toContain("I couldn't do that");
    expect(reply.stage?.choices).toEqual([
      "$0.01 — FD *CA DMV 640 *SVC (09-06)",
      "$0.01 — FD *CA DMV 640 (09-06)",
    ]);
  });

  it("stages the whole batch with the question", async () => {
    const reply = await ask();
    const batch = parsePending(reply.stage!.payload);
    expect(batch.kind).toBe("disambiguate");
    expect(batch.step).toBe(0);
    expect(batch.candidates).toEqual([31, 30]);
    expect(batch.actions).toHaveLength(1);
  });

  // The round trip a button tap makes: pin the chosen row onto the step that
  // asked, re-plan, and the question becomes a confirmation.
  it("turns an answer into a confirmation of that charge", async () => {
    const batch = parsePending((await ask()).stage!.payload);
    const answered = batch.actions.map((intent, i) =>
      i === batch.step ? { ...intent, txnId: batch.candidates[1] } : intent,
    );
    const reply = await executeBatch(fakeEnv({ transactions: dmv }), answered);

    expect(reply.text).toContain("Confirm this?");
    expect(reply.text).toContain("$0.01 — FD *CA DMV 640 (09-06)");
    expect(reply.stage?.choices).toBeUndefined();
    expect(parsePending(reply.stage!.payload).kind).toBe("confirm");
    expect(parsePending(reply.stage!.payload).actions[0].txnId).toBe(30);
  });

  // A hard failure elsewhere in the batch can't be answered away, so there is
  // nothing to ask about.
  it("reports a broken step rather than asking about another one", async () => {
    const reply = await executeBatch(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({
        actions: [correct(byMerchant("DMV"), 616), { action: "set_budget", amount: 0 }],
      }),
    );
    expect(reply.stage).toBeUndefined();
    expect(reply.text).toContain("haven't done any of it");
  });
});

describe("pinned transactions", () => {
  // The write that made this necessary: an approved correction re-ran its
  // selector and updated a charge at a different merchant.
  it("applies to the pinned row, not whatever the selector matches now", async () => {
    const env = fakeEnv({ transactions: dmv });
    await applyApproved(
      env,
      normalizeBatch({
        actions: [correct({ selector_kind: "amount", amount: 0.01, txn_id: 30 }, 616)],
      }),
    );
    const write = env.writes.find((w: any) => w.sql.includes("UPDATE transactions SET amount"));
    expect(write.binds).toEqual([616, 30]);
  });

  it("names the pinned row in the outcome", async () => {
    const text = await applyApproved(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({
        actions: [correct({ selector_kind: "amount", amount: 0.01, txn_id: 30 }, 616)],
      }),
    );
    expect(text).toContain("Changed FD *CA DMV 640 from $0.01");
  });

  it("reports a pinned row that has since been deleted", async () => {
    const text = await applyApproved(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({
        actions: [correct({ selector_kind: "amount", amount: 0.01, txn_id: 999 }, 616)],
      }),
    );
    expect(text).toContain("no longer there");
  });

  // A batch staged before pinning existed, confirmed after this deployed: it
  // carries a selector and no row id, and still has to apply.
  it("falls back to the selector for a batch staged without a pin", async () => {
    const env = fakeEnv({ transactions: dmv });
    await applyApproved(
      env,
      normalizeBatch({ actions: [correct({ selector_kind: "amount", amount: 0.01 }, 616)] }),
    );
    const write = env.writes.find((w: any) => w.sql.includes("UPDATE transactions SET amount"));
    expect(write.binds).toEqual([616, 20]);
  });

  it("carries the pin through a confirmation round trip", async () => {
    const reply = await executeBatch(
      fakeEnv({ transactions: dmv }),
      normalizeBatch({ actions: [correct(byMerchant("FD *CA DMV 640"), 616)] }),
    );
    const staged = parsePending(reply.stage!.payload);
    expect(staged.actions[0].txnId).toBe(30);

    const env = fakeEnv({ transactions: dmv });
    await applyApproved(env, staged.actions);
    const write = env.writes.find((w: any) => w.sql.includes("UPDATE transactions SET amount"));
    expect(write.binds).toEqual([616, 30]);
  });
});

describe("parsePending", () => {
  it("reads a confirmation payload", () => {
    const batch = parsePending(
      JSON.stringify({ kind: "confirm", actions: [{ action: "set_budget", amount: 400 }] }),
    );
    expect(batch.kind).toBe("confirm");
    expect(batch.actions[0].amount).toBe(400);
  });

  // Rows staged before payloads had a kind hold a bare action list. They must
  // still apply on Yes, and must never read as an unanswered question.
  it("treats a legacy payload as a confirmation", () => {
    expect(parsePending(JSON.stringify([{ action: "set_budget", amount: 400 }])).kind).toBe("confirm");
    expect(parsePending(JSON.stringify({ action: "set_budget", amount: 400 })).kind).toBe("confirm");
  });

  it("degrades a malformed payload to an empty confirmation", () => {
    const batch = parsePending("{not json");
    expect(batch.kind).toBe("confirm");
    expect(batch.actions).toHaveLength(1);
    expect(batch.actions[0].action).toBe("unknown");
  });

  it("drops candidate ids that aren't ids", () => {
    const batch = parsePending(
      JSON.stringify({ kind: "disambiguate", step: 1, candidates: [7, "x", -2, null], actions: [] }),
    );
    expect(batch.candidates).toEqual([7]);
  });
});
