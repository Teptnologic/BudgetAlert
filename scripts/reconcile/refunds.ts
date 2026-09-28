// Pair refunds and benefit credits with the purchases they undo. Pure.
//
// A fully refunded purchase disappears along with its refund; a partial refund
// leaves the purchase at its net amount. Matching stays on one card, and a
// refund only ever reduces a sale dated on or before it.

import type { BankRow } from "./normalize";

const EPS = 0.005;

export interface LedgerRow {
  row: BankRow;
  /** What's left after refunds and credits. 0 means fully refunded. */
  net: number;
  offsets: { by: BankRow; amount: number }[];
}

export interface RefundResult {
  ledger: LedgerRow[]; // every sale and fee, including fully refunded ones
  kept: LedgerRow[]; // net > 0 — what belongs in the budget
  unmatched: BankRow[]; // refunds/credits with no purchase to offset
  ignored: BankRow[]; // payments and generic cashback
}

// Word prefixes need trailing whitespace so "SP " never eats "SPOTHERO".
const PREFIXES = /^(?:(?:REFUND|APLPAY|SP)\s+|(?:PAYPAL|TST|SQ|CL|DD|UEP|FH)\s?\*\s*)/i;
const SKIP = new Set(["THE", "WWW", "HELP"]);

/** Tokens that identify a merchant, prefixes like "AplPay " and "PAYPAL *" removed. */
export function merchantTokens(desc: string): string[] {
  let s = desc.toUpperCase().replace(/&AMP;/g, "&");
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(PREFIXES, "");
  }
  return s.split(/[^A-Z0-9]+/).filter((t) => t.length >= 2 && !SKIP.has(t));
}

/** First token that names the merchant rather than a store number. */
export function merchantKey(desc: string): string {
  return merchantTokens(desc).find((t) => /[A-Z]/.test(t)) ?? "";
}

function orderNumbers(desc: string): string[] {
  return merchantTokens(desc).filter((t) => /^\d{6,}$/.test(t));
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

/** Which purchase a benefit credit was for. */
function creditTarget(credit: BankRow): ((l: LedgerRow) => boolean) | null {
  const m = credit.merchant.toUpperCase();
  if (credit.creditFor) {
    const key = merchantKey(credit.creditFor);
    return key ? (l) => merchantKey(l.row.merchant) === key : null;
  }
  if (/STUBHUB/.test(m)) return (l) => /STUBHUB/i.test(l.row.merchant);
  if (/TRAVEL|THE EDIT/.test(m)) return (l) => /CHASE TRAVEL/i.test(l.row.merchant);
  if (/DINING/.test(m)) return (l) => /Food & Drink/i.test(l.row.bankCategory);
  return null;
}

function apply(target: LedgerRow, by: BankRow): void {
  const amount = Math.min(by.amount, target.net);
  target.net = Math.round((target.net - amount) * 100) / 100;
  target.offsets.push({ by, amount });
}

export function applyRefunds(rows: BankRow[]): RefundResult {
  const ledger: LedgerRow[] = rows
    .filter((r) => r.kind === "sale" || r.kind === "fee")
    .map((row) => ({ row, net: row.amount, offsets: [] }));
  const ignored = rows.filter((r) => r.kind === "payment" || r.kind === "cashback");
  const unmatched: BankRow[] = [];

  // Refunds: same card, same merchant, sale on or before the refund.
  const refunds = rows
    .filter((r) => r.kind === "refund")
    .sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);

  const candidates = (refund: BankRow): LedgerRow[] => {
    const key = merchantKey(refund.merchant);
    let c = ledger.filter(
      (l) =>
        l.row.card === refund.card &&
        l.row.date <= refund.date &&
        l.net > EPS &&
        key !== "" &&
        merchantKey(l.row.merchant) === key,
    );
    // An order number on both sides (IKEA 493172236) pins the exact purchase.
    const orders = orderNumbers(refund.merchant);
    const pinned = c.filter((l) => orderNumbers(l.row.merchant).some((o) => orders.includes(o)));
    if (pinned.length) c = pinned;
    return c;
  };
  const nearest = (a: LedgerRow, b: LedgerRow) =>
    b.row.date.localeCompare(a.row.date) || a.net - b.net;

  // Exact amounts first, so a partial refund can't take the sale an exact one needs.
  const pending: BankRow[] = [];
  for (const refund of refunds) {
    const exact = candidates(refund)
      .filter((l) => Math.abs(l.net - refund.amount) < EPS)
      .sort(nearest)[0];
    if (exact) apply(exact, refund);
    else pending.push(refund);
  }
  for (const refund of pending) {
    const fit = candidates(refund)
      .filter((l) => l.net >= refund.amount - EPS)
      .sort(nearest)[0];
    if (fit) apply(fit, refund);
    else unmatched.push(refund);
  }

  // Benefit credits: the purchase they were earned on, up to a week earlier.
  const credits = rows
    .filter((r) => r.kind === "credit")
    .sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  for (const credit of credits) {
    const target = creditTarget(credit);
    const best = !target
      ? undefined
      : ledger
          .filter((l) => {
            const d = dayDiff(credit.date, l.row.date);
            return (
              l.row.card === credit.card &&
              d >= 0 &&
              d <= 7 &&
              l.net >= credit.amount - EPS &&
              target(l)
            );
          })
          .sort(
            (a, b) =>
              Number(Math.abs(b.net - credit.amount) < EPS) -
                Number(Math.abs(a.net - credit.amount) < EPS) ||
              dayDiff(credit.date, a.row.date) - dayDiff(credit.date, b.row.date) ||
              b.net - a.net,
          )[0];
    if (best) apply(best, credit);
    else unmatched.push(credit);
  }

  return { ledger, kept: ledger.filter((l) => l.net > EPS), unmatched, ignored };
}
