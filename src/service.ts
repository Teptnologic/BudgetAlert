// Shared application pipeline used by the email handler, the generic inbound
// webhook, and the Telegram commands. Ties the pure core to storage + delivery.

import type { Env } from "./env";
import type { ParsedTxn } from "./core/parser";
import type { Period } from "./core/period";
import { periodStart, periodLabel, daysAgo, isPeriod } from "./core/period";
import {
  computeStatus,
  alertsToFire,
  formatMoney,
  type BudgetStatus,
} from "./core/engine";
import {
  getConfig,
  insertTransaction,
  sumSince,
  listSince,
  getSentAlerts,
  markAlertSent,
  listCategories,
} from "./store/d1";
import { sendMessage } from "./notify/telegram";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Record a parsed spend, then evaluate the budget and fire any newly-crossed
// threshold alerts to the group. Called for every captured transaction.
export async function recordAndEvaluate(
  env: Env,
  parsed: ParsedTxn,
  occurredAt: string,
  source: string,
): Promise<void> {
  const cfg = await getConfig(env);
  const currency = parsed.currency ?? cfg.currency;

  const rawHash = await sha256Hex(
    `${parsed.amount}|${parsed.merchant ?? ""}|${occurredAt}|${source}`,
  );
  const inserted = await insertTransaction(env, {
    amount: parsed.amount,
    merchant: parsed.merchant,
    currency,
    occurredAt,
    source,
    rawHash,
  });
  if (!inserted) return; // duplicate — already processed

  if (!cfg.group_chat_id || cfg.budget_amount <= 0) return; // nothing to alert to

  const start = periodStart(cfg.period as Period);
  const startIso = start.toISOString();
  const spent = await sumSince(env, startIso);
  const status = computeStatus(cfg.budget_amount, spent, cfg.currency);

  const alreadySent = await getSentAlerts(env, startIso);
  const fire = alertsToFire(status.pct, cfg.warn_pct, cfg.alert_pct, alreadySent);

  for (const level of fire) {
    await sendMessage(
      env,
      cfg.group_chat_id,
      thresholdMessage(level, status, cfg.warn_pct, cfg.alert_pct, cfg.period as Period, start),
    );
    await markAlertSent(env, startIso, level);
  }
}

// Human-readable current status — used by the on-demand `/status` command.
// Shows the default envelope, then one line per category budget.
export async function budgetStatusText(env: Env): Promise<string> {
  const cfg = await getConfig(env);
  if (cfg.budget_amount <= 0) {
    return "No budget set yet. Send <code>/budget 500</code> to set one.";
  }
  const start = periodStart(cfg.period as Period);
  // Uncategorized spend only — categorized charges belong to their own envelope.
  const spent = await sumSince(env, start.toISOString());
  const status = computeStatus(cfg.budget_amount, spent, cfg.currency);
  const label = periodLabel(cfg.period as Period, start);
  const bar = progressBar(status.pct);

  let out =
    `<b>Budget — ${label}</b>\n` +
    `${bar} ${status.pct.toFixed(0)}%\n` +
    `Spent: ${formatMoney(status.spent, status.currency)} of ${formatMoney(status.budget, status.currency)}\n` +
    `Remaining: <b>${formatMoney(status.remaining, status.currency)}</b>`;

  const cats = await listCategories(env);
  if (cats.length) {
    const lines: string[] = [];
    for (const c of cats) {
      const p: Period = isPeriod(c.period) ? c.period : "yearly";
      const cSpent = await sumSince(env, periodStart(p).toISOString(), c.id);
      const remaining = c.amount - cSpent;
      lines.push(
        `• ${c.label}: ${formatMoney(cSpent, cfg.currency)} of ` +
          `${formatMoney(c.amount, cfg.currency)} — ${formatMoney(remaining, cfg.currency)} left`,
      );
    }
    out += `\n\n<b>Other envelopes</b>\n${lines.join("\n")}`;
  }
  return out;
}

// Weekly digest: last 7 days of spend + progress toward the budget period.
export async function weeklySummaryText(env: Env): Promise<string | null> {
  const cfg = await getConfig(env);
  if (!cfg.group_chat_id || cfg.budget_amount <= 0) return null;

  const weekStart = daysAgo(7);
  const weekTxns = await listSince(env, weekStart.toISOString());
  const weekSpent = weekTxns.reduce((sum, t) => sum + t.amount, 0);

  const start = periodStart(cfg.period as Period);
  const periodSpent = await sumSince(env, start.toISOString());
  const status = computeStatus(cfg.budget_amount, periodSpent, cfg.currency);
  const label = periodLabel(cfg.period as Period, start);

  const top = [...weekTxns]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map((t) => `  • ${formatMoney(t.amount, cfg.currency)} — ${t.merchant ?? "unknown"}`)
    .join("\n");

  return (
    `<b>📊 Weekly summary</b>\n` +
    `Spent in the last 7 days: <b>${formatMoney(weekSpent, cfg.currency)}</b> ` +
    `across ${weekTxns.length} transaction${weekTxns.length === 1 ? "" : "s"}.\n\n` +
    `<b>${label} so far</b>\n` +
    `${progressBar(status.pct)} ${status.pct.toFixed(0)}%\n` +
    `Remaining: <b>${formatMoney(status.remaining, cfg.currency)}</b>\n` +
    (top ? `\n<b>Biggest this week</b>\n${top}` : "")
  );
}

export function groupChatId(cfg: { group_chat_id: string | null }): string | null {
  return cfg.group_chat_id;
}

function thresholdMessage(
  level: "warn" | "alert",
  status: BudgetStatus,
  warnPct: number,
  alertPct: number,
  period: Period,
  start: Date,
): string {
  const label = periodLabel(period, start);
  if (level === "alert") {
    const over = status.remaining < 0;
    return (
      `🚨 <b>Budget ${over ? "exceeded" : "reached"}</b> — ${label}\n` +
      `You've used ${status.pct.toFixed(0)}% (${alertPct}% threshold).\n` +
      `Spent: ${formatMoney(status.spent, status.currency)} of ${formatMoney(status.budget, status.currency)}\n` +
      (over
        ? `Over by <b>${formatMoney(-status.remaining, status.currency)}</b>.`
        : `Remaining: <b>${formatMoney(status.remaining, status.currency)}</b>.`)
    );
  }
  return (
    `⚠️ <b>Heads up</b> — ${label}\n` +
    `You've used ${status.pct.toFixed(0)}% of your budget (${warnPct}% threshold).\n` +
    `Remaining: <b>${formatMoney(status.remaining, status.currency)}</b>.`
  );
}

function progressBar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}
