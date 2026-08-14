-- Budget envelopes (categories) + transaction assignment.
--
-- Apply with:  npm run db:migrate        (remote)
--              npm run db:migrate:local  (local wrangler dev)
--
-- NOTE: this file is NOT idempotent — `ALTER TABLE ... ADD COLUMN` fails if the
-- column already exists. Run it exactly once per database. schema.sql stays
-- re-runnable for fresh installs and carries the same definitions.

CREATE TABLE IF NOT EXISTS categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,             -- lowercase key, e.g. 'gift'
  label  TEXT NOT NULL,                    -- display, e.g. 'Yearly gift budget'
  amount REAL NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT 'yearly'    -- 'weekly' | 'monthly' | 'yearly'
);

-- NULL category_id = the default budget envelope.
ALTER TABLE transactions ADD COLUMN category_id INTEGER REFERENCES categories(id);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions (category_id);

-- Pending natural-language actions awaiting a Yes/No confirmation tap.
-- `token` is what rides in Telegram's 64-byte callback_data budget.
CREATE TABLE IF NOT EXISTS pending_actions (
  token      TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  intent     TEXT NOT NULL,                -- JSON-encoded normalized intent
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
