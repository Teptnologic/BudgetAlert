// D1 storage adapter — the only host-specific data layer. To run on a plain
// server with a SQLite file later, reimplement this module against that driver;
// nothing else in the app talks to the database directly.

import type { Env } from "../env";
import type { AlertLevel } from "../core/engine";
import type { Period } from "../core/period";

export interface ConfigRow {
  budget_amount: number;
  currency: string;
  period: string;
  warn_pct: number;
  alert_pct: number;
  group_chat_id: string | null;
}

export interface NewTxn {
  amount: number;
  merchant: string | null;
  currency: string | null;
  occurredAt: string; // ISO
  source: string;
  rawHash: string;
}

export async function getConfig(env: Env): Promise<ConfigRow> {
  const row = await env.DB.prepare(
    `SELECT budget_amount, currency, period, warn_pct, alert_pct, group_chat_id
     FROM config WHERE id = 1`,
  ).first<ConfigRow>();
  if (row) return row;
  // Fall back to env defaults if the row is somehow missing.
  return {
    budget_amount: 0,
    currency: env.CURRENCY ?? "USD",
    period: env.BUDGET_PERIOD ?? "monthly",
    warn_pct: env.WARN_PCT ? Number(env.WARN_PCT) : 80,
    alert_pct: env.ALERT_PCT ? Number(env.ALERT_PCT) : 100,
    group_chat_id: null,
  };
}

export async function setBudget(env: Env, amount: number): Promise<void> {
  await env.DB.prepare(`UPDATE config SET budget_amount = ? WHERE id = 1`).bind(amount).run();
}

export async function setGroupChat(env: Env, chatId: string): Promise<void> {
  await env.DB.prepare(`UPDATE config SET group_chat_id = ? WHERE id = 1`).bind(chatId).run();
}

export async function setPeriod(env: Env, period: Period): Promise<void> {
  await env.DB.prepare(`UPDATE config SET period = ? WHERE id = 1`).bind(period).run();
}

// Returns true if inserted, false if this was a duplicate (same raw_hash).
export async function insertTransaction(env: Env, txn: NewTxn): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO transactions
       (amount, merchant, currency, occurred_at, source, raw_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(txn.amount, txn.merchant, txn.currency, txn.occurredAt, txn.source, txn.rawHash)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// Envelopes are EXCLUSIVE: a transaction counts toward exactly one budget.
// `categoryId === null` therefore means "the default budget", and must match
// only rows with no category — not all rows. This is the invariant that makes
// moving a charge into another envelope raise the default budget's remaining.
export async function sumSince(
  env: Env,
  sinceIso: string,
  categoryId: number | null = null,
): Promise<number> {
  const sql =
    categoryId === null
      ? `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
         WHERE occurred_at >= ? AND category_id IS NULL`
      : `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
         WHERE occurred_at >= ? AND category_id = ?`;
  const stmt =
    categoryId === null
      ? env.DB.prepare(sql).bind(sinceIso)
      : env.DB.prepare(sql).bind(sinceIso, categoryId);
  const row = await stmt.first<{ total: number }>();
  return row?.total ?? 0;
}

export interface TxnRow {
  amount: number;
  merchant: string | null;
  occurred_at: string;
}

export async function listSince(
  env: Env,
  sinceIso: string,
  categoryId: number | null = null,
): Promise<TxnRow[]> {
  const sql =
    categoryId === null
      ? `SELECT amount, merchant, occurred_at FROM transactions
         WHERE occurred_at >= ? AND category_id IS NULL ORDER BY occurred_at DESC`
      : `SELECT amount, merchant, occurred_at FROM transactions
         WHERE occurred_at >= ? AND category_id = ? ORDER BY occurred_at DESC`;
  const stmt =
    categoryId === null
      ? env.DB.prepare(sql).bind(sinceIso)
      : env.DB.prepare(sql).bind(sinceIso, categoryId);
  const res = await stmt.all<TxnRow>();
  return res.results ?? [];
}

export async function getSentAlerts(env: Env, periodStartIso: string): Promise<Set<AlertLevel>> {
  const res = await env.DB.prepare(
    `SELECT level FROM alerts_sent WHERE period_start = ?`,
  )
    .bind(periodStartIso)
    .all<{ level: AlertLevel }>();
  return new Set((res.results ?? []).map((r) => r.level));
}

export async function markAlertSent(
  env: Env,
  periodStartIso: string,
  level: AlertLevel,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO alerts_sent (period_start, level) VALUES (?, ?)`,
  )
    .bind(periodStartIso, level)
    .run();
}

/* ---------------------------------------------------------------- categories */

export interface CategoryRow {
  id: number;
  name: string;
  label: string;
  amount: number;
  period: string;
}

export async function listCategories(env: Env): Promise<CategoryRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, name, label, amount, period FROM categories ORDER BY name`,
  ).all<CategoryRow>();
  return res.results ?? [];
}

export async function findCategory(env: Env, name: string): Promise<CategoryRow | null> {
  return await env.DB.prepare(
    `SELECT id, name, label, amount, period FROM categories WHERE name = ?`,
  )
    .bind(name.toLowerCase())
    .first<CategoryRow>();
}

export async function upsertCategory(
  env: Env,
  name: string,
  label: string,
  amount: number,
  period: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO categories (name, label, amount, period) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET label = excluded.label,
                                     amount = excluded.amount,
                                     period = excluded.period`,
  )
    .bind(name.toLowerCase(), label, amount, period)
    .run();
}

export async function setCategoryBudget(env: Env, id: number, amount: number): Promise<void> {
  await env.DB.prepare(`UPDATE categories SET amount = ? WHERE id = ?`).bind(amount, id).run();
}

/* -------------------------------------------------------------- transactions */

export interface FullTxnRow {
  id: number;
  amount: number;
  merchant: string | null;
  occurred_at: string;
  category_id: number | null;
}

export async function recentTransactions(env: Env, limit = 10): Promise<FullTxnRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, amount, merchant, occurred_at, category_id FROM transactions
     ORDER BY occurred_at DESC, id DESC LIMIT ?`,
  )
    .bind(Math.max(1, Math.min(50, limit)))
    .all<FullTxnRow>();
  return res.results ?? [];
}

// Locate one transaction for a move. Returns the newest match, or null.
//
// `excludeIds` skips rows already claimed by an earlier step of the same batch.
// Without it, two "move the last charge" steps in one message both resolve to
// the newest row and one of the moves is silently lost.
export async function findTransaction(
  env: Env,
  kind: "last" | "amount" | "merchant",
  value: string | number,
  excludeIds: number[] = [],
): Promise<FullTxnRow | null> {
  // Ids are numbers we produced, never user text, so inlining them is safe —
  // D1 has no variadic bind for IN lists.
  const skip = excludeIds.length
    ? ` AND id NOT IN (${excludeIds.map((n) => Number(n)).join(",")})`
    : "";
  const cols = `SELECT id, amount, merchant, occurred_at, category_id FROM transactions`;
  const order = `ORDER BY occurred_at DESC, id DESC LIMIT 1`;

  if (kind === "last") {
    return await env.DB.prepare(`${cols} WHERE 1=1${skip} ${order}`).first<FullTxnRow>();
  }
  if (kind === "amount") {
    // Tolerate float representation drift rather than comparing for equality.
    return await env.DB.prepare(`${cols} WHERE ABS(amount - ?) < 0.005${skip} ${order}`)
      .bind(Number(value))
      .first<FullTxnRow>();
  }
  return await env.DB.prepare(`${cols} WHERE merchant LIKE ?${skip} ${order}`)
    .bind(`%${String(value)}%`)
    .first<FullTxnRow>();
}

// Record a transaction the bank never emailed about — cash, a split bill, a
// card the alerts aren't wired to.
//
// Unlike email capture there is nothing to dedupe against: two $4 coffees on
// the same day are two real transactions, so the hash is random rather than
// derived from the contents.
export async function addManualTransaction(
  env: Env,
  amount: number,
  merchant: string | null,
  currency: string,
  occurredAt: string,
  categoryId: number | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO transactions
       (amount, merchant, currency, occurred_at, source, raw_hash, category_id)
     VALUES (?, ?, ?, ?, 'manual', ?, ?)`,
  )
    .bind(amount, merchant, currency, occurredAt, `manual:${crypto.randomUUID()}`, categoryId)
    .run();
}

// Correct a captured amount — bank alerts often land pre-tip, or get the figure
// wrong outright. Budget totals are summed live, so every status recomputes on
// the next read with no cached figure to invalidate.
export async function setTxnAmount(env: Env, txnId: number, amount: number): Promise<void> {
  await env.DB.prepare(`UPDATE transactions SET amount = ? WHERE id = ?`)
    .bind(amount, txnId)
    .run();
}

export async function setTxnCategory(
  env: Env,
  txnId: number,
  categoryId: number | null,
): Promise<void> {
  await env.DB.prepare(`UPDATE transactions SET category_id = ? WHERE id = ?`)
    .bind(categoryId, txnId)
    .run();
}

/* ----------------------------------------------------------- pending actions */

export interface PendingRow {
  token: string;
  chat_id: string;
  intent: string;
  summary: string;
}

export async function savePending(
  env: Env,
  token: string,
  chatId: string,
  intentJson: string,
  summary: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pending_actions (token, chat_id, intent, summary) VALUES (?, ?, ?, ?)`,
  )
    .bind(token, chatId, intentJson, summary)
    .run();
}

// Consume a pending action: returns it and deletes it, so a double-tap on the
// confirmation button can't apply the same change twice. Entries older than 10
// minutes are treated as expired (and swept here rather than on a timer).
export async function takePending(env: Env, token: string): Promise<PendingRow | null> {
  const row = await env.DB.prepare(
    `SELECT token, chat_id, intent, summary FROM pending_actions
     WHERE token = ? AND created_at >= datetime('now', '-10 minutes')`,
  )
    .bind(token)
    .first<PendingRow>();
  await env.DB.prepare(
    `DELETE FROM pending_actions WHERE token = ? OR created_at < datetime('now', '-10 minutes')`,
  )
    .bind(token)
    .run();
  return row;
}
