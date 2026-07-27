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

-- Budget envelopes. A transaction belongs to at most one; NULL category_id on a
-- transaction means the default budget above. Envelopes are exclusive — spend
-- assigned to a category does NOT also count against the default budget.
CREATE TABLE IF NOT EXISTS categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,             -- lowercase key, e.g. 'gift'
  label  TEXT NOT NULL,                    -- display, e.g. 'Yearly gift budget'
  amount REAL NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT 'yearly'    -- 'weekly' | 'monthly' | 'yearly'
);

-- One row per captured spend.
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  amount      REAL    NOT NULL,
  merchant    TEXT,
  currency    TEXT,
  occurred_at TEXT    NOT NULL,                       -- ISO 8601
  source      TEXT,                                   -- 'email' | 'webhook' | 'manual'
  raw_hash    TEXT    UNIQUE,                          -- dedupe key
  category_id INTEGER REFERENCES categories(id),      -- NULL = default budget
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_occurred ON transactions (occurred_at);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions (category_id);

-- Natural-language actions awaiting a Yes/No confirmation tap. `token` is what
-- rides in Telegram's 64-byte callback_data budget.
CREATE TABLE IF NOT EXISTS pending_actions (
  token      TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  intent     TEXT NOT NULL,                -- JSON-encoded normalized intent
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tracks which threshold alerts have already fired in a given budget period,
-- so we alert once per level per period instead of on every transaction.
CREATE TABLE IF NOT EXISTS alerts_sent (
  period_start TEXT NOT NULL,
  level        TEXT NOT NULL,                          -- 'warn' | 'alert'
  sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (period_start, level)
);
