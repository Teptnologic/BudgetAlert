import { describe, it, expect } from "vitest";
import { computeStatus, alertsToFire } from "../src/core/engine";
import { periodStart } from "../src/core/period";

describe("computeStatus", () => {
  it("computes remaining and pct", () => {
    const s = computeStatus(500, 125, "USD");
    expect(s.remaining).toBe(375);
    expect(s.pct).toBe(25);
  });

  it("handles overspend", () => {
    const s = computeStatus(100, 130, "USD");
    expect(s.remaining).toBe(-30);
    expect(s.pct).toBe(130);
  });

  it("avoids divide-by-zero with no budget", () => {
    expect(computeStatus(0, 50, "USD").pct).toBe(0);
  });
});

describe("alertsToFire", () => {
  it("fires nothing below the warn threshold", () => {
    expect(alertsToFire(50, 80, 100, new Set())).toEqual([]);
  });

  it("fires warn once crossing 80%", () => {
    expect(alertsToFire(85, 80, 100, new Set())).toEqual(["warn"]);
  });

  it("does not re-fire an already-sent warn", () => {
    expect(alertsToFire(85, 80, 100, new Set(["warn"]))).toEqual([]);
  });

  it("fires both when jumping straight past 100%", () => {
    expect(alertsToFire(120, 80, 100, new Set())).toEqual(["warn", "alert"]);
  });

  it("fires only alert when warn already sent", () => {
    expect(alertsToFire(120, 80, 100, new Set(["warn"]))).toEqual(["alert"]);
  });
});

describe("periodStart", () => {
  it("monthly returns first of month UTC", () => {
    const s = periodStart("monthly", new Date("2026-07-19T10:00:00Z"));
    expect(s.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("weekly returns the Monday", () => {
    // 2026-07-19 is a Sunday → previous Monday is 2026-07-13
    const s = periodStart("weekly", new Date("2026-07-19T10:00:00Z"));
    expect(s.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("weekly on a Monday returns that same day", () => {
    const s = periodStart("weekly", new Date("2026-07-13T23:00:00Z"));
    expect(s.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });
});
