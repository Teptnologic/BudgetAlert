// Turning a selector ("the last charge", "$84", "FD *CA DMV 640") into the ONE
// transaction the user meant — or admitting it can't.
//
// Selectors are user text and routinely match several rows. The store used to
// hand back the newest match and the planner took it, which fails two ways at
// once:
//
//   1. "change FD *CA DMV 640 to $616, change FD *CA DMV 640 *SVC to $12.94"
//      — the first selector is a PREFIX of the second, so resolving in message
//      order let step 1 take the *SVC row and left step 2 with nothing.
//   2. A lone "$0.01" selector matches every $0.01 pre-auth hold on the
//      account, and picking the newest is a coin flip the user never sees.
//
// So resolution is a batch-wide assignment, not a per-step lookup:
//   · a row pinned by an earlier pass is honored as-is and claimed first;
//   · a step whose selector matches EXACTLY one free row is settled, and
//     settling it frees the others to settle in turn (the DMV case: the longer
//     selector matches one row, which takes it out of the shorter's pool);
//   · 'last' takes the newest row nobody else has claimed;
//   · whatever is still undecided is reported as ambiguous, for the caller to
//     ask about, rather than guessed at.

import type { Env } from "../env";
import type { Intent } from "./schema";
import { MAX_ACTIONS } from "./schema";
import { findTransactions, getTransaction, type FullTxnRow } from "../store/d1";

// How many candidates a "which one did you mean?" prompt can list. Past this a
// list of buttons stops being an answer and starts being another problem, so
// the user is asked to narrow it down instead.
export const MAX_CANDIDATES = 5;

// One step's worth of pool: enough rows that every other step in the batch
// could claim one and this step would still have MAX_CANDIDATES of its own.
const POOL = MAX_CANDIDATES + MAX_ACTIONS;

export type Resolution =
  | { kind: "one"; txn: FullTxnRow }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: FullTxnRow[] }
  | { kind: "too-many"; count: number; capped: boolean };

const SELECTOR_ACTIONS: ReadonlySet<string> = new Set([
  "move_transaction",
  "set_transaction_amount",
  "remove_transaction",
  "unfile_transaction",
]);

// Whether this step picks an existing transaction at all. A step with
// selector_kind 'none' is a misparse the planner reports itself.
export function hasSelector(intent: Intent): boolean {
  return SELECTOR_ACTIONS.has(intent.action) && intent.selectorKind !== "none";
}

// A merchant selector that matches one row EXACTLY outranks the rows it merely
// appears inside. "FD *CA DMV 640" names a real merchant; that it is also a
// prefix of "FD *CA DMV 640 *SVC" shouldn't make the request ambiguous.
function preferExact(rows: FullTxnRow[], selector: string): FullTxnRow[] {
  const needle = selector.trim().toLowerCase();
  if (!needle) return rows;
  const exact = rows.filter((r) => (r.merchant ?? "").trim().toLowerCase() === needle);
  return exact.length ? exact : rows;
}

/**
 * Assign a transaction to every selector-bearing step of a batch.
 *
 * Returns a map keyed by the step's index in `intents`; steps that don't carry
 * a selector are absent. Claims are batch-wide, so no two steps resolve to the
 * same row.
 */
export async function resolveBatch(
  env: Env,
  intents: Intent[],
): Promise<Map<number, Resolution>> {
  const out = new Map<number, Resolution>();
  const claimed = new Set<number>();

  const steps = intents
    .map((intent, index) => ({ intent, index }))
    .filter((s) => hasSelector(s.intent));
  if (!steps.length) return out;

  // A row pinned by an earlier planning pass is not up for reassignment — the
  // user already answered "which one?" and that answer outranks any selector.
  const open: typeof steps = [];
  for (const s of steps) {
    if (s.intent.txnId <= 0) {
      open.push(s);
      continue;
    }
    const txn = await getTransaction(env, s.intent.txnId);
    if (txn) {
      out.set(s.index, { kind: "one", txn });
      claimed.add(txn.id);
    } else {
      out.set(s.index, { kind: "none" });
    }
  }

  const pool = new Map<number, FullTxnRow[]>();
  for (const s of open) {
    const kind = s.intent.selectorKind;
    if (kind === "none") continue; // unreachable: hasSelector() excluded these
    const value = kind === "amount" ? s.intent.amount : s.intent.selectorValue;
    const rows = await findTransactions(env, kind, value, POOL);
    pool.set(s.index, kind === "merchant" ? preferExact(rows, s.intent.selectorValue) : rows);
  }

  const free = (index: number): FullTxnRow[] =>
    (pool.get(index) ?? []).filter((t) => !claimed.has(t.id));

  const settle = (index: number, txn: FullTxnRow) => {
    out.set(index, { kind: "one", txn });
    claimed.add(txn.id);
  };

  // Steps that name a specific charge. 'last' is deliberately excluded: it
  // means "whatever is newest", so it can never be the one forced choice that
  // unlocks another step — and it must not claim a row out from under one.
  const named = open.filter((s) => s.intent.selectorKind !== "last");

  // Settle every forced choice, then look again: each claim can force another.
  const propagate = () => {
    for (let pass = 0; pass < named.length; pass++) {
      let settled = false;
      for (const s of named) {
        if (out.has(s.index)) continue;
        const rows = free(s.index);
        if (rows.length === 1) {
          settle(s.index, rows[0]);
          settled = true;
        }
      }
      if (!settled) return;
    }
  };

  propagate();

  // 'last' goes after, taking the newest row the named steps left alone, so
  // "remove the Starbucks charge and the last one" doesn't hand the same row to
  // both. Message order decides between two 'last' steps.
  for (const s of open) {
    if (s.intent.selectorKind !== "last" || out.has(s.index)) continue;
    const rows = free(s.index);
    if (rows.length) settle(s.index, rows[0]);
    else out.set(s.index, { kind: "none" });
  }

  // A 'last' claim can leave a named step with exactly one option.
  propagate();

  for (const s of named) {
    if (out.has(s.index)) continue;
    const rows = free(s.index);
    if (!rows.length) out.set(s.index, { kind: "none" });
    else if (rows.length > MAX_CANDIDATES) {
      out.set(s.index, { kind: "too-many", count: rows.length, capped: rows.length >= POOL });
    } else out.set(s.index, { kind: "ambiguous", candidates: rows });
  }

  return out;
}
