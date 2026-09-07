// Which job a cron firing is asking for. Pure & host-agnostic.
//
// Cloudflare hands scheduled() the cron expression that fired, and the Worker
// registers several. Matching the exact strings from wrangler.toml would break
// silently the moment someone shifts an hour to avoid a collision, so the shape
// of the schedule is classified instead: what a trigger fires ON decides what
// it means.
//
//   * * SUN      → every week          → the weekly digest
//   1st of 1     → once a year         → a yearly report
//   1st of 1,4,7,10 → four times a year → a quarterly report
//   1st of *     → every month         → a monthly report
//
// Anything unrecognized falls back to the weekly digest, which is what this
// Worker did before reports existed.
export type ScheduledJob = "weekly" | "monthly" | "quarterly" | "yearly";

const MONTH_NAMES = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

function inRange(field: string, min: number, max: number): boolean {
  const n = Number(field.trim());
  return Number.isInteger(n) && n >= min && n <= max;
}

/** A single day of the month, e.g. "1". Ranges and steps are not this shape. */
function isDayOfMonth(field: string): boolean {
  return inRange(field, 1, 31);
}

/** A comma list of months, numeric or named: "1", "1,4,7,10", "JAN,APR". */
function isMonthList(field: string): boolean {
  const parts = field.split(",");
  return parts.every(
    (part) => inRange(part, 1, 12) || MONTH_NAMES.includes(part.trim().toLowerCase()),
  );
}

export function scheduledJob(cron: string | undefined | null): ScheduledJob {
  const fields = (cron ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return "weekly";
  const [, , dayOfMonth, month] = fields;

  // No day-of-month restriction means it repeats within every month, so the
  // only period it can be reporting on is the week.
  if (dayOfMonth === "*") return "weekly";
  // Every field is validated before it is read as meaning something: without
  // this, any five-token string lands on a report and the documented fallback
  // to the weekly digest would be a lie.
  if (!isDayOfMonth(dayOfMonth)) return "weekly";
  if (month === "*") return "monthly";
  if (!isMonthList(month)) return "weekly";

  return month.split(",").length === 1 ? "yearly" : "quarterly";
}

/** The report window a job covers. Weekly is the digest, not a report. */
export function jobWindow(job: Exclude<ScheduledJob, "weekly">): "month" | "quarter" | "year" {
  return job === "yearly" ? "year" : job === "quarterly" ? "quarter" : "month";
}
