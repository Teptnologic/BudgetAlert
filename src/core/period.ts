// Budget-period math. Pure & host-agnostic.

export type Period = "weekly" | "monthly" | "yearly";

export function isPeriod(value: string): value is Period {
  return value === "weekly" || value === "monthly" || value === "yearly";
}

// Start of the current budget period, in UTC, as a Date.
// - weekly:  most recent Monday at 00:00 UTC
// - monthly: first day of the current month at 00:00 UTC
// - yearly:  January 1 of the current year at 00:00 UTC
export function periodStart(period: Period, now: Date = new Date()): Date {
  if (period === "weekly") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dow = d.getUTCDay(); // 0 = Sun
    const daysSinceMonday = (dow + 6) % 7;
    d.setUTCDate(d.getUTCDate() - daysSinceMonday);
    return d;
  }
  if (period === "yearly") {
    return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// Start of a period `offset` periods before the current one.
// offset 0 = this week/month/year, 1 = the previous one, and so on.
export function periodStartAt(period: Period, offset: number, now: Date = new Date()): Date {
  const back = Math.max(0, Math.trunc(offset));
  if (period === "weekly") {
    const d = periodStart("weekly", now);
    d.setUTCDate(d.getUTCDate() - back * 7);
    return d;
  }
  if (period === "yearly") {
    return new Date(Date.UTC(now.getUTCFullYear() - back, 0, 1));
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
}

// Exclusive end of the period beginning at `start` — the instant the next one
// opens, so a range query is `>= start AND < end`.
export function periodEnd(period: Period, start: Date): Date {
  if (period === "weekly") {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }
  if (period === "yearly") {
    return new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1));
  }
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

export function periodLabel(period: Period, start: Date): string {
  if (period === "weekly") {
    return `week of ${start.toISOString().slice(0, 10)}`;
  }
  if (period === "yearly") {
    return String(start.getUTCFullYear());
  }
  return start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// N days ago at 00:00 UTC — used by the weekly summary window.
export function daysAgo(n: number, now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
