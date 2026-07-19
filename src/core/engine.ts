// Budget engine. Pure & host-agnostic — decides status and which threshold
// alerts should fire, given already-known numbers. No I/O here.

export interface BudgetStatus {
  budget: number;
  spent: number;
  remaining: number;
  pct: number; // 0..∞, percent of budget used
  currency: string;
}

export function computeStatus(budget: number, spent: number, currency: string): BudgetStatus {
  const pct = budget > 0 ? (spent / budget) * 100 : 0;
  return {
    budget,
    spent,
    remaining: budget - spent,
    pct,
    currency,
  };
}

export type AlertLevel = "warn" | "alert";

// Given the current percent-used, the configured thresholds, and which levels
// have already fired this period, return the levels that should fire now.
// Crossing straight past the warn threshold to the alert threshold fires both.
export function alertsToFire(
  pct: number,
  warnPct: number,
  alertPct: number,
  alreadySent: Set<AlertLevel>,
): AlertLevel[] {
  const fire: AlertLevel[] = [];
  if (pct >= warnPct && !alreadySent.has("warn")) fire.push("warn");
  if (pct >= alertPct && !alreadySent.has("alert")) fire.push("alert");
  return fire;
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
