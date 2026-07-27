import { describe, it, expect } from "vitest";
import { INTENT_SCHEMA, normalizeIntent, isMutating, unknownIntent } from "../src/nl/schema";
import { periodStart, periodLabel, isPeriod } from "../src/core/period";

// The API caps a request at 24 optional parameters and 16 parameters using
// `anyOf` or type arrays; exceeding the grammar's limits fails with
// "Schema is too complex for compilation" — a 400 on a user's message rather
// than a build error. These tests fail the build instead, so a future branch
// added to the schema can't quietly push it over.
describe("INTENT_SCHEMA complexity budget", () => {
  const props = Object.entries(INTENT_SCHEMA.properties as Record<string, any>);
  const required = new Set(INTENT_SCHEMA.required as readonly string[]);

  it("has no optional parameters", () => {
    const optional = props.filter(([name]) => !required.has(name)).map(([n]) => n);
    expect(optional).toEqual([]);
    expect(optional.length).toBeLessThanOrEqual(24);
  });

  it("uses no anyOf or type arrays", () => {
    const unions = props.filter(
      ([, spec]) => "anyOf" in spec || Array.isArray(spec.type),
    );
    expect(unions).toEqual([]);
    expect(unions.length).toBeLessThanOrEqual(16);
  });

  it("is flat — no nested object or array properties", () => {
    const nested = props
      .filter(([, spec]) => spec.type === "object" || spec.type === "array")
      .map(([n]) => n);
    expect(nested).toEqual([]);
  });

  it("forbids extra properties and requires every declared property", () => {
    expect(INTENT_SCHEMA.additionalProperties).toBe(false);
    expect(required.size).toBe(props.length);
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
});

describe("isMutating", () => {
  it("flags exactly the write actions", () => {
    for (const a of ["move_transaction", "set_budget", "create_category", "set_period"] as const) {
      expect(isMutating(a)).toBe(true);
    }
    for (const a of ["get_status", "query_spend", "list_recent", "unknown"] as const) {
      expect(isMutating(a)).toBe(false);
    }
  });

  it("treats an unparseable message as a non-mutating unknown", () => {
    expect(isMutating(unknownIntent("nope").action)).toBe(false);
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
