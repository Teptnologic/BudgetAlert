// Budget-period math. Pure & host-agnostic.
//
// Periods are computed in a real timezone, not UTC. This matters at every
// boundary: on US Pacific a Saturday-night dinner at 6pm local is already
// Sunday 01:00 UTC, so UTC math would file it in the following week and it
// would vanish from the week you actually spent it in.
//
// All arithmetic is done on LOCAL calendar dates and only converted to an
// instant at the end, so adding "7 days" across a daylight-saving change lands
// on local midnight rather than drifting an hour.

export type Period = "weekly" | "monthly" | "yearly";

/** 0 = weeks begin Sunday, 1 = weeks begin Monday. */
export type WeekStart = 0 | 1;

export interface Calendar {
  timeZone: string;
  weekStartsOn: WeekStart;
}

export const DEFAULT_CALENDAR: Calendar = {
  timeZone: "America/Los_Angeles",
  weekStartsOn: 0,
};

export function isPeriod(value: string): value is Period {
  return value === "weekly" || value === "monthly" || value === "yearly";
}

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

// How far the zone is from UTC at a given instant, in ms. Derived by formatting
// the instant in the zone and reading it back as if it were UTC, which handles
// daylight saving without a timezone database.
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Some locales render midnight as hour 24; normalize before use.
  const asIfUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asIfUTC - instant.getTime();
}

function localDate(instant: Date, timeZone: string): LocalDate {
  const shifted = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

// 0 = Sunday. Computed from the local calendar date, not the instant.
function localDayOfWeek(d: LocalDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

function addDays(d: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  t.setUTCDate(t.getUTCDate() + n);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

// The instant of local midnight on a local date. Applied twice because the
// offset itself depends on the instant, and the first guess can sit on the
// wrong side of a daylight-saving change.
function startOfLocalDay(d: LocalDate, timeZone: string): Date {
  const naive = Date.UTC(d.year, d.month - 1, d.day);
  let guess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  guess = new Date(naive - zoneOffsetMs(guess, timeZone));
  return guess;
}

/** Start of the current budget period, as an instant. */
export function periodStart(
  period: Period,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): Date {
  return periodStartAt(period, 0, now, cal);
}

/**
 * Start of the period `offset` periods before the current one.
 * offset 0 = this week/month/year, 1 = the previous one.
 */
export function periodStartAt(
  period: Period,
  offset: number,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): Date {
  const back = Math.max(0, Math.trunc(offset));
  const today = localDate(now, cal.timeZone);

  if (period === "weekly") {
    const sinceStart = (localDayOfWeek(today) - cal.weekStartsOn + 7) % 7;
    return startOfLocalDay(addDays(today, -sinceStart - back * 7), cal.timeZone);
  }
  if (period === "yearly") {
    return startOfLocalDay({ year: today.year - back, month: 1, day: 1 }, cal.timeZone);
  }
  // Month arithmetic via a UTC probe so December rolls the year correctly.
  const m = new Date(Date.UTC(today.year, today.month - 1 - back, 1));
  return startOfLocalDay(
    { year: m.getUTCFullYear(), month: m.getUTCMonth() + 1, day: 1 },
    cal.timeZone,
  );
}

/**
 * Exclusive end of the period beginning at `start` — the instant the next one
 * opens, so a range query is `>= start AND < end` and no transaction can fall
 * into two periods.
 */
export function periodEnd(
  period: Period,
  start: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): Date {
  const d = localDate(start, cal.timeZone);
  if (period === "weekly") return startOfLocalDay(addDays(d, 7), cal.timeZone);
  if (period === "yearly") {
    return startOfLocalDay({ year: d.year + 1, month: 1, day: 1 }, cal.timeZone);
  }
  const m = new Date(Date.UTC(d.year, d.month, 1)); // month is 1-based, so this is next month
  return startOfLocalDay(
    { year: m.getUTCFullYear(), month: m.getUTCMonth() + 1, day: 1 },
    cal.timeZone,
  );
}

export function periodLabel(
  period: Period,
  start: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): string {
  const d = localDate(start, cal.timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (period === "weekly") return `week of ${d.year}-${pad(d.month)}-${pad(d.day)}`;
  if (period === "yearly") return String(d.year);
  return new Date(Date.UTC(d.year, d.month - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Local midnight N days ago — the start of that local day, as an instant. */
export function daysAgo(
  n: number,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): Date {
  return startOfLocalDay(addDays(localDate(now, cal.timeZone), -n), cal.timeZone);
}
