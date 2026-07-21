-- BudgetAlert D1 schema.
-- Apply with:  npm run db:init        (remote)
--              npm run db:init:local  (local wrangler dev)

-- Single-row settings table.
CREATE TABLE IF NOT EXISTS config (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  budget_amount REAL    NOT NULL DEFAULT 0,
  currency      TEXT    NOT NULL DEFAULT 'USD',
  period        TEXT    NOT NULL DEFAULT 'weekly',   -- 'weekly' | 'monthly'
  warn_pct      REAL    NOT NULL DEFAULT 80,
  alert_pct     REAL    NOT NULL DEFAULT 100,
  group_chat_id TEXT                                  -- Telegram chat to notify
);
INSERT OR IGNORE INTO config (id) VALUES (1);

-- One row per captured spend.
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  amount      REAL    NOT NULL,
  merchant    TEXT,
  currency    TEXT,
  occurred_at TEXT    NOT NULL,                       -- ISO 8601
  source      TEXT,                                   -- 'email' | 'webhook' | 'manual'
  raw_hash    TEXT    UNIQUE,                          -- dedupe key
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_occurred ON transactions (occurred_at);

-- Tracks which threshold alerts have already fired in a given budget period,
-- so we alert once per level per period instead of on every transaction.
CREATE TABLE IF NOT EXISTS alerts_sent (
  period_start TEXT NOT NULL,
  level        TEXT NOT NULL,                          -- 'warn' | 'alert'
  sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (period_start, level)
);
