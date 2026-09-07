import { describe, it, expect } from "vitest";
import { scheduledJob, jobWindow } from "../src/core/schedule";

// The Worker registers several crons behind one scheduled() handler, so this
// classifier decides what each firing means. Matching wrangler.toml's exact
// strings would break silently the moment an hour shifts, so it reads the shape.
describe("scheduledJob", () => {
  it("classifies the crons wrangler.toml actually registers", () => {
    expect(scheduledJob("0 16 * * SUN")).toBe("weekly");
    expect(scheduledJob("0 17 1 1,4,7,10 *")).toBe("quarterly");
    expect(scheduledJob("0 18 1 1 *")).toBe("yearly");
  });

  // The point of classifying by shape: moving a report an hour must not
  // silently turn it back into a weekly digest.
  it("survives the hour being changed", () => {
    expect(scheduledJob("30 6 1 1,4,7,10 *")).toBe("quarterly");
    expect(scheduledJob("0 23 1 1 *")).toBe("yearly");
  });

  it("reads a first-of-every-month trigger as monthly", () => {
    expect(scheduledJob("0 17 1 * *")).toBe("monthly");
  });

  it("treats anything without a day-of-month as the weekly digest", () => {
    expect(scheduledJob("0 16 * * MON")).toBe("weekly");
    expect(scheduledJob("*/5 * * * *")).toBe("weekly");
  });

  // Falling back to the digest keeps a malformed or absent cron behaving the
  // way this handler did before reports existed.
  it("falls back to the weekly digest on junk", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "0 16 * *", // too few fields
      "0 16 * * SUN extra", // too many
      "not a cron at all", // five tokens, none of them cron fields
      "0 16 1 notamonth *", // plausible shape, unreadable month
      "0 16 99 1 *", // day out of range
      "0 16 1-5 1 *", // a range, not the single-day shape this reads
    ]) {
      expect(scheduledJob(bad)).toBe("weekly");
    }
  });

  it("accepts named months as well as numbers", () => {
    expect(scheduledJob("0 17 1 JAN,APR,JUL,OCT *")).toBe("quarterly");
    expect(scheduledJob("0 18 1 JAN *")).toBe("yearly");
  });

  it("maps each report job to its window", () => {
    expect(jobWindow("quarterly")).toBe("quarter");
    expect(jobWindow("yearly")).toBe("year");
    expect(jobWindow("monthly")).toBe("month");
  });
});
