// D1 storage adapter — the only host-specific data layer. To run on a plain
// server with a SQLite file later, reimplement this module against that driver;
// nothing else in the app talks to the database directly.

import type { Env } from "../env";
import type { AlertLevel } from "../core/engine";

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

export async function setPeriod(env: Env, period: "weekly" | "monthly"): Promise<void> {
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

export async function sumSince(env: Env, sinceIso: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE occurred_at >= ?`,
  )
    .bind(sinceIso)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export interface TxnRow {
  amount: number;
  merchant: string | null;
  occurred_at: string;
}

export async function listSince(env: Env, sinceIso: string): Promise<TxnRow[]> {
  const res = await env.DB.prepare(
    `SELECT amount, merchant, occurred_at FROM transactions
     WHERE occurred_at >= ? ORDER BY occurred_at DESC`,
  )
    .bind(sinceIso)
    .all<TxnRow>();
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
