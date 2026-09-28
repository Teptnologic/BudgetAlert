// The human review sheet for a reconcile run. Pure: returns Markdown.
//
// Every change the SQL would make is listed here under its key, so nothing
// reaches D1 that the user hasn't had the chance to read and strike.

import type { BankRow } from "./normalize";
import type { RefundResult, LedgerRow } from "./refunds";
import type { Reconciliation, D1Txn } from "./diff";
import type { Change } from "./emit-sql";
import { localDayIso } from "../../src/core/period";

const $ = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function table(head: string[], rows: string[][]): string {
  if (!rows.length) return "_None._\n";
  return (
    [
      `| ${head.join(" | ")} |`,
      `|${head.map(() => "---").join("|")}|`,
      ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
    ].join("\n") + "\n"
  );
}

const d1Cell = (d: D1Txn) =>
  `#${d.id} ${$(d.amount)} ${d.merchant ?? "—"} (${localDayIso(new Date(d.occurred_at))})`;
const bankCell = (l: LedgerRow) => `${$(l.net)} ${l.row.merchant} (${l.row.card} ${l.row.date})`;

/** How a change moves the grand total: + for inserts, − for deletes, the difference for updates. */
export function changeToTotal(c: Change): number {
  return c.kind === "insert" ? c.amount : c.kind === "delete" ? -c.amount : c.amount - (c.was ?? 0);
}
const net = changeToTotal;

const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * The same changes as the Markdown, one CSV row each, for a spreadsheet.
 * Struck keys stay in with `skipped = yes`, so nothing silently disappears.
 */
export function renderChangesCsv(changes: Change[], skip: Set<string>, botStart: string | null): string {
  const head = [
    "key",
    "action",
    "d1_id",
    "date",
    "card",
    "merchant",
    "amount",
    "previous_amount",
    "change_to_total",
    "window",
    "reason",
    "skipped",
  ];
  const rows = changes.map((c) => [
    c.key,
    c.kind,
    c.d1Id === undefined ? "" : String(c.d1Id),
    c.date,
    c.card ?? "",
    c.merchant,
    c.amount.toFixed(2),
    c.was === undefined ? "" : c.was.toFixed(2),
    changeToTotal(c).toFixed(2),
    c.kind === "insert" && botStart ? (c.date < botStart ? "before-bot" : "after-bot") : "",
    c.reason,
    skip.has(c.key) ? "yes" : "",
  ]);
  // BOM first: Excel reads UTF-8 without one as Latin-1 and mangles "Chase …1714".
  return "\uFEFF" + [head, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

export interface ReportInput {
  rows: BankRow[];
  refunds: RefundResult;
  rec: Reconciliation;
  changes: Change[];
  skip: Set<string>;
  /** First local day D1 has anything for; null when no D1 export was given. */
  botStart: string | null;
}

export function renderReport({ rows, refunds, rec, changes, skip, botStart }: ReportInput): string {
  const out: string[] = ["# BudgetAlert history reconcile — proposed changes", ""];
  const live = changes.filter((c) => !skip.has(c.key));
  const of = (k: Change["kind"]) => live.filter((c) => c.kind === k);

  out.push(
    "Nothing here has been applied. Strike any key you don't want with",
    "`npm run reconcile -- … --skip I-0012,D-0003` and re-read this file.",
    "",
  );
  if (!botStart) out.push("_No D1 export was given, so every kept charge is planned as an insert. Re-run with `--d1`._", "");
  if (skip.size) out.push(`Skipped: ${[...skip].sort().join(", ")}`, "");

  out.push("## Summary", "");
  out.push(
    table(
      ["Change", "Rows", "Effect on total"],
      [
        ["Delete", String(of("delete").length), $(sum(of("delete").map(net)))],
        ["Update", String(of("update").length), $(sum(of("update").map(net)))],
        ["Insert", String(of("insert").length), $(sum(of("insert").map(net)))],
      ],
    ),
  );

  // ------------------------------------------------------------ the changes
  const changeRows = (cs: Change[]) =>
    cs.map((c) => [
      c.key,
      c.d1Id ? `#${c.d1Id}` : "",
      c.date,
      c.card ?? "",
      c.merchant,
      c.kind === "update" ? `${$(c.was ?? 0)} → ${$(c.amount)}` : $(c.amount),
      c.reason,
    ]);
  const head = ["Key", "D1", "Date", "Card", "Merchant", "Amount", "Why"];

  out.push("## Deletes", "", table(head, changeRows(of("delete"))));
  out.push("## Updates", "", table(head, changeRows(of("update"))));

  const inserts = of("insert");
  if (botStart) {
    const before = inserts.filter((c) => c.date < botStart);
    const after = inserts.filter((c) => c.date >= botStart);
    out.push(
      `## Inserts from ${botStart} onward — the bot was running, check these closely`,
      "",
      `${after.length} rows, ${$(sum(after.map((c) => c.amount)))}. Each is a statement charge nothing in D1 accounts for.`,
      "",
      table(head, changeRows(after)),
    );
    out.push(
      `## Inserts before ${botStart} — before the bot existed`,
      "",
      `${before.length} rows, ${$(sum(before.map((c) => c.amount)))}.`,
      "",
      table(head, changeRows(before)),
    );
  } else {
    out.push("## Inserts", "", table(head, changeRows(inserts)));
  }

  // ------------------------------------------------ how D1 was accounted for
  const outs = rec.outcomes;
  out.push("## Already in D1 — no change", "");
  out.push("### Matched at a different amount (tip, your share, or your correction) — D1 kept", "");
  out.push(
    table(
      ["D1 row", "Statement"],
      outs.flatMap((o) => (o.type === "matched" && o.note ? [[d1Cell(o.d1), bankCell(o.bank)]] : [])),
    ),
  );
  out.push("### Matched as a group — D1 kept", "");
  out.push(
    table(
      ["D1 rows", "Statement", "How"],
      outs.flatMap((o) =>
        o.type === "group" ? [[o.d1.map(d1Cell).join("<br>"), o.bank.map(bankCell).join("<br>"), o.note]] : [],
      ),
    ),
  );
  const exact = outs.filter((o) => o.type === "matched" && !o.note).length;
  out.push(`Plus ${exact} D1 rows that match a statement charge exactly.`, "");
  out.push("### In D1 but on no statement — kept", "");
  out.push(
    "Manual entries, charges after the exports end, or cards not exported.",
    "",
    table(["D1 row", "Source"], outs.flatMap((o) => (o.type === "d1-only" ? [[d1Cell(o.d1), o.d1.source ?? ""]] : []))),
  );

  // ------------------------------------------------------- statement side
  const cards = [...new Set(rows.map((r) => r.card))].sort();
  out.push("## Statements", "", "### Per card", "");
  out.push(
    table(
      ["Card", "Span", "Purchases", "Gross", "Refunds/credits applied", "Net"],
      cards.map((card) => {
        const l = refunds.ledger.filter((x) => x.row.card === card);
        const dates = rows.filter((r) => r.card === card).map((r) => r.date).sort();
        const gross = sum(l.map((x) => x.row.amount));
        const n = sum(l.map((x) => x.net));
        return [card, `${dates[0]} → ${dates.at(-1)}`, String(l.length), $(gross), $(gross - n), $(n)];
      }),
    ),
  );

  const offsetRow = (l: LedgerRow) => [
    l.row.card,
    l.row.date,
    l.row.merchant,
    $(l.row.amount),
    l.offsets.map((o) => `${o.by.kind} ${$(o.amount)} (${o.by.date} ${o.by.merchant})`).join("; "),
    l.net > 0.005 ? $(l.net) : "dropped",
  ];
  const offset = refunds.ledger.filter((l) => l.offsets.length);
  out.push("### Fully refunded — excluded", "");
  out.push(table(["Card", "Date", "Merchant", "Charged", "Offset by", "Result"], offset.filter((l) => l.net <= 0.005).map(offsetRow)));
  out.push("### Partially refunded — kept at net", "");
  out.push(table(["Card", "Date", "Merchant", "Charged", "Offset by", "Net"], offset.filter((l) => l.net > 0.005).map(offsetRow)));
  out.push("### Refunds and credits with no purchase to offset — not applied", "");
  out.push(
    "Usually the purchase was before the export window or on another card.",
    "",
    table(
      ["Card", "Date", "Kind", "Merchant", "Amount"],
      refunds.unmatched.map((r) => [r.card, r.date, r.kind, r.merchant, $(r.amount)]),
    ),
  );
  const cashback = refunds.ignored.filter((r) => r.kind === "cashback");
  out.push("### Ignored cashback and rebates", "");
  out.push(table(["Card", "Date", "Merchant", "Amount"], cashback.map((r) => [r.card, r.date, r.merchant, $(r.amount)])));
  out.push(`Payments to the cards (${refunds.ignored.length - cashback.length} rows) are ignored too.`, "");
  return out.join("\n");
}
