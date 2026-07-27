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
