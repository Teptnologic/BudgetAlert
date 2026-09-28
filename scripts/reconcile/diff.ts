// Line the bank ledger up against what the bot already has in D1. Pure.
//
// The two rarely agree row for row. Alerts land pre-tip; DoorDash sends one
// alert per restaurant but bills one combined order; the user rolls several
// charges into one manual entry, records only their half of a shared bill, or
// corrects an amount. So matching runs in passes, most certain first, and
// every pass only sees what the earlier ones left:
//
//   1. exact amount, 1:1
//   2. sums — several alerts = one charge, or one entry = several charges
//   3. close amount (±20%), 1:1
//   4. amounts the user set on purpose — half the charge, or any amount at an
//      unmistakable merchant a day or two apart — then split alerts whose sum
//      drifted a few percent from the posted order (tip, promo)
//   5. $0.01 pre-auth holds — become the real charge, or go
//   6. a correction that landed on the wrong row
//
// Whatever D1 already holds wins; the bank only fills gaps, fixes holds and
// removes refunded charges.

import { localDayIso } from "../../src/core/period";
import type { LedgerRow } from "./refunds";
import { merchantTokens } from "./refunds";

export interface D1Txn {
  id: number;
  amount: number;
  merchant: string | null;
  occurred_at: string;
  source: string | null;
  category_id: number | null;
}

export type Outcome =
  | { type: "matched"; bank: LedgerRow; d1: D1Txn; note?: string } // keep D1 as-is
  | { type: "group"; bank: LedgerRow[]; d1: D1Txn[]; note: string } // keep D1 as-is
  | { type: "update"; d1: D1Txn; amount: number; reason: string; bank?: LedgerRow }
  | { type: "delete"; d1: D1Txn; reason: string; bank?: LedgerRow }
  | { type: "insert"; bank: LedgerRow }
  | { type: "d1-only"; d1: D1Txn };

export interface Reconciliation {
  outcomes: Outcome[];
  counts: Record<Outcome["type"], number>;
}

/** Rows out of `wrangler d1 execute --json`, or a plain array of rows. */
export function parseD1Export(json: unknown): D1Txn[] {
  const arr = Array.isArray(json) ? json : [json];
  const rows = arr.flatMap((x: any) => (x && Array.isArray(x.results) ? x.results : [x]));
  return rows
    .filter((r: any) => r && typeof r.id === "number" && r.occurred_at)
    .map((r: any) => ({
      id: r.id,
      amount: Number(r.amount),
      merchant: r.merchant ?? null,
      occurred_at: r.occurred_at,
      source: r.source ?? null,
      category_id: r.category_id ?? null,
    }));
}

const EPS = 0.005;
const HOLD_MAX = 1; // alerts at or under this are card-verification holds
const isHold = (d: D1Txn) => d.amount <= HOLD_MAX || /TEMP AUTH/i.test(d.merchant ?? "");
// Merchants seen so often that a name match alone says nothing about which charge.
const GENERIC = /DOORDASH|AMAZON|PAYPAL|UBER|APPLE|CHARGEPOINT|COSTCO|LYFT|TESLA|STARBUCKS/i;

const d1Day = (d: D1Txn) => localDayIso(new Date(d.occurred_at));
const cents = (n: number) => Math.round(n * 100);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Signed days from a to b (b later → positive). */
function days(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function words(s: string | null): string[] {
  return s ? merchantTokens(s).filter((t) => t.length >= 3 && /[A-Z]/.test(t)) : [];
}

/**
 * Share of the shorter name's words found in the other. A word matches its
 * prefix, so the alert's "DOORDASH" finds the statement's "DOORDASHCOOKINGCOO".
 */
export function merchantSimilarity(a: string | null, b: string | null): number {
  const ta = words(a);
  const tb = words(b);
  if (!ta.length || !tb.length) return 0;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const hit = short.filter((s) =>
    long.some((l) => l === s || (Math.min(l.length, s.length) >= 5 && (l.startsWith(s) || s.startsWith(l)))),
  ).length;
  return hit / short.length;
}

const bankAmounts = (b: LedgerRow) => [...new Set([b.net, b.row.amount])].filter((a) => a > EPS);

/** Subsets of 2–`max` items whose amounts sum to `target` within `tolerance`. */
function subsetSum<T>(
  items: T[],
  amount: (t: T) => number,
  target: number,
  tolerance = 0.01,
  max = 4,
): T[] | null {
  const goal = cents(target);
  const tol = cents(tolerance);
  const pool = items.slice(0, 12);
  const pick = (start: number, left: number, sum: number, chosen: T[]): T[] | null => {
    if (chosen.length >= 2 && Math.abs(sum - goal) <= tol) return chosen;
    if (left === 0) return null;
    for (let i = start; i < pool.length; i++) {
      const next = sum + cents(amount(pool[i]));
      if (next - goal > tol) continue;
      const found = pick(i + 1, left - 1, next, [...chosen, pool[i]]);
      if (found) return found;
    }
    return null;
  };
  return pick(0, max, 0, []);
}

export function reconcile(ledger: LedgerRow[], d1: D1Txn[]): Reconciliation {
  const outcomes: Outcome[] = [];
  const bankFree = new Set(ledger.map((_, i) => i));
  const d1Free = new Set(d1.map((_, i) => i));
  const holds = new Set(d1.flatMap((r, i) => (isHold(r) ? [i] : [])));

  const take = (b: number[], d: number[]) => {
    b.forEach((i) => bankFree.delete(i));
    d.forEach((i) => d1Free.delete(i));
  };
  const pairFor = (bank: LedgerRow, row: D1Txn): Outcome =>
    bank.net <= EPS
      ? { type: "delete", d1: row, bank, reason: "charge was fully refunded" }
      : bank.offsets.length &&
          Math.abs(row.amount - bank.row.amount) < EPS &&
          Math.abs(row.amount - bank.net) >= EPS
        ? { type: "update", d1: row, bank, amount: bank.net, reason: "partially refunded — set to net" }
        : {
            type: "matched",
            d1: row,
            bank,
            note: Math.abs(row.amount - bank.net) >= EPS ? "amount differs — D1 kept" : undefined,
          };

  /** One greedy 1:1 pass: best-scoring pairs first. */
  const pass = (score: (b: LedgerRow, d: D1Txn) => number | null) => {
    const pairs: { b: number; d: number; s: number }[] = [];
    for (const b of bankFree)
      for (const d of d1Free) {
        if (holds.has(d)) continue;
        const s = score(ledger[b], d1[d]);
        if (s !== null) pairs.push({ b, d, s });
      }
    pairs.sort((x, y) => y.s - x.s);
    for (const p of pairs) {
      if (!bankFree.has(p.b) || !d1Free.has(p.d)) continue;
      take([p.b], [p.d]);
      outcomes.push(pairFor(ledger[p.b], d1[p.d]));
    }
  };

  // 1. Exact amount.
  pass((b, d) => {
    const gap = Math.abs(days(b.row.date, d1Day(d)));
    const sim = merchantSimilarity(b.row.merchant, d.merchant);
    if (!bankAmounts(b).some((a) => Math.abs(a - d.amount) < EPS)) return null;
    // Some merchants post days after the alert; allow it only when the name is unmistakable.
    if (gap > (sim >= 0.5 && !GENERIC.test(b.row.merchant) ? 7 : 3)) return null;
    if (sim === 0 && gap > 1) return null; // same amount, different shop, days apart
    return 3 + 2 * sim - 0.25 * gap;
  });

  // 2a. Several D1 alerts = one statement charge (split DoorDash orders).
  const splitAlerts = (tolerance: (target: number) => number, note: string) => {
    for (const b of [...bankFree].sort((x, y) => ledger[x].row.date.localeCompare(ledger[y].row.date))) {
      const bank = ledger[b];
      if (bank.net <= EPS) continue;
      const cands = [...d1Free].filter((d) => {
        const gap = days(d1Day(d1[d]), bank.row.date);
        return !holds.has(d) && gap >= 0 && gap <= 3 && merchantSimilarity(bank.row.merchant, d1[d].merchant) > 0;
      });
      for (const target of bankAmounts(bank)) {
        const hit = subsetSum(cands, (d) => d1[d].amount, target, tolerance(target));
        if (!hit) continue;
        take([b], hit);
        const total = sum(hit.map((d) => d1[d].amount));
        outcomes.push({
          type: "group",
          bank: [bank],
          d1: hit.map((d) => d1[d]),
          note: `${hit.length} alerts = one charge${Math.abs(total - target) >= EPS ? ` (${note}: alerts $${total.toFixed(2)})` : ""}`,
        });
        break;
      }
    }
  };
  splitAlerts(() => 0.01, "");

  // 2b. One D1 entry = several statement charges (manual roll-ups, split fares).
  for (const d of [...d1Free]) {
    if (holds.has(d) || !d1Free.has(d)) continue;
    const row = d1[d];
    const manual = row.source === "manual";
    const cands = [...bankFree]
      .filter((b) => {
        const l = ledger[b];
        const gap = Math.abs(days(l.row.date, d1Day(row)));
        return l.net > EPS && gap <= 1 && (manual || merchantSimilarity(l.row.merchant, row.merchant) > 0);
      })
      // Name matches first, so a coincidental sum of unrelated charges loses.
      .sort((x, y) => merchantSimilarity(ledger[y].row.merchant, row.merchant) - merchantSimilarity(ledger[x].row.merchant, row.merchant));
    const hit = subsetSum(cands, (b) => ledger[b].net, row.amount);
    if (!hit) continue;
    take(hit, [d]);
    outcomes.push({ type: "group", bank: hit.map((b) => ledger[b]), d1: [row], note: `one entry = ${hit.length} charges` });
  }

  // 3. Close amount at a matching merchant — pre-tip alerts, small corrections.
  pass((b, d) => {
    const gap = Math.abs(days(b.row.date, d1Day(d)));
    const sim = merchantSimilarity(b.row.merchant, d.merchant);
    const rel = Math.min(...bankAmounts(b).map((a) => Math.abs(a - d.amount) / a));
    if (gap > 3 || sim === 0 || rel > 0.2) return null;
    return 1 - rel + 2 * sim - 0.25 * gap;
  });

  // 4. Amounts set on purpose: the user's half of a shared bill, or any
  //    amount at a merchant too specific to be a coincidence.
  pass((b, d) => {
    const gap = Math.abs(days(b.row.date, d1Day(d)));
    const sim = merchantSimilarity(b.row.merchant, d.merchant);
    if (gap > 2 || sim === 0) return null;
    const half = bankAmounts(b).some((a) => Math.abs(a / 2 - d.amount) <= Math.max(0.05, a * 0.01));
    if (half) return 2 + sim - 0.25 * gap;
    if (sim >= 0.5 && gap <= 1 && !GENERIC.test(b.row.merchant)) return 1 + sim - 0.25 * gap;
    return null;
  });

  // 4b. Split alerts whose total drifted a little from the posted order.
  splitAlerts((target) => Math.max(0.5, target * 0.05), "tip or promo");

  // 5. Holds: a $0.01 alert whose real charge the bot never heard about.
  for (const d of [...holds]) {
    const row = d1[d];
    const b = [...bankFree]
      .filter((i) => {
        const gap = days(d1Day(row), ledger[i].row.date);
        return ledger[i].net > EPS && gap >= 0 && gap <= 5 && merchantSimilarity(ledger[i].row.merchant, row.merchant) > 0;
      })
      .sort((x, y) => merchantSimilarity(ledger[y].row.merchant, row.merchant) - merchantSimilarity(ledger[x].row.merchant, row.merchant) ||
        days(d1Day(row), ledger[x].row.date) - days(d1Day(row), ledger[y].row.date))[0];
    take(b === undefined ? [] : [b], [d]);
    if (b !== undefined && Math.abs(ledger[b].net - row.amount) < EPS) {
      outcomes.push({ type: "matched", d1: row, bank: ledger[b] });
      continue;
    }
    if (b !== undefined) {
      outcomes.push({ type: "update", d1: row, bank: ledger[b], amount: ledger[b].net, reason: "pre-auth hold — set to the posted charge" });
      continue;
    }
    const real = d1.find((o) => o.amount > HOLD_MAX && merchantSimilarity(o.merchant, row.merchant) > 0 && days(d1Day(row), d1Day(o)) >= 0 && days(d1Day(row), d1Day(o)) <= 60);
    outcomes.push({
      type: "delete",
      d1: row,
      reason: real ? `pre-auth hold — real charge already recorded as #${real.id}` : "pre-auth hold that never posted",
    });
  }

  // 6. A correction that landed on the wrong row: D1 carries another charge's
  //    exact amount, and that charge is now accounted for elsewhere.
  const claimed = new Set(
    outcomes.flatMap((o) => (o.type === "update" && o.bank ? [cents(o.bank.net)] : [])),
  );
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o.type !== "matched" || !o.note) continue;
    if (!claimed.has(cents(o.d1.amount))) continue;
    outcomes[i] = {
      type: "update",
      d1: o.d1,
      bank: o.bank,
      amount: o.bank.net,
      reason: `$${o.d1.amount.toFixed(2)} belongs to another charge — set to this one's posted amount`,
    };
  }

  for (const b of bankFree) if (ledger[b].net > EPS) outcomes.push({ type: "insert", bank: ledger[b] });
  for (const d of d1Free) outcomes.push({ type: "d1-only", d1: d1[d] });

  const counts = { matched: 0, group: 0, update: 0, delete: 0, insert: 0, "d1-only": 0 };
  for (const o of outcomes) counts[o.type]++;
  return { outcomes, counts };
}
