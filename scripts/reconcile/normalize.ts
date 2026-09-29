// Bank CSV exports → one normalized row shape. Pure: no fs, no Node imports.
//
// Every bank signs amounts differently, so each gets its own reader and all of
// them emit `amount` as a positive magnitude with `kind` saying what it is.
//   Chase     sale negative, Type column says Sale/Return/Payment/Adjustment/Fee
//   Wells     sale negative, no type column — positives are payments or credits
//   Discover  sale positive, category marks payments and rebates
//   AMEX      sale positive, negative "Platinum … Credit" rows are benefit credits

export type Kind =
  | "sale" //     spending
  | "fee" //      card fee — counts as spending
  | "refund" //   merchant return, offsets a sale
  | "credit" //   card-benefit credit tied to a purchase, offsets a sale
  | "cashback" // generic reward — ignored
  | "payment"; // paying the card — ignored

export interface BankRow {
  id: string; // stable within one export: `${card}#${index}`
  card: string;
  date: string; // YYYY-MM-DD, the transaction (not post) date
  merchant: string;
  amount: number; // positive magnitude
  kind: Kind;
  bankCategory: string;
  /** Benefit credits only: which merchant the credit was for, when the bank says. */
  creditFor?: string;
}

/** RFC 4180 reader — AMEX puts newlines inside quoted fields. */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) records.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) records.push(row);

  const [header, ...body] = records;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** MM/DD/YYYY → YYYY-MM-DD */
function isoDate(us: string): string {
  const [m, d, y] = us.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export function cleanMerchant(desc: string): string {
  return desc.replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

const PAYMENT = /PAYMENT|THANK YOU|DIRECTPAY|AUTOPAY/i;

/** Which card a file belongs to, from its file name. */
export function cardFromFilename(name: string): string {
  const base = name.split("/").pop() ?? name;
  const chase = /^Chase(\d{4})/i.exec(base);
  if (chase) return `Chase …${chase[1]}`;
  if (/^WF/i.test(base)) return "Wells Fargo";
  if (/^Discover/i.test(base)) return "Discover";
  if (/^Amex/i.test(base)) return "AMEX";
  return base.replace(/\.[^.]+$/, "");
}

type Draft = Omit<BankRow, "id" | "card">;

function chase(r: Record<string, string>): Draft {
  const raw = Number(r["Amount"]);
  const merchant = cleanMerchant(r["Description"]);
  const type = r["Type"];
  let kind: Kind;
  if (type === "Sale") kind = "sale";
  else if (type === "Return") kind = "refund";
  else if (type === "Payment") kind = "payment";
  else if (type === "Fee") kind = "fee";
  else if (/^Offer:/i.test(merchant)) kind = "cashback";
  else kind = raw > 0 ? "credit" : "sale"; // Adjustment: benefit credit, or a rare debit
  return {
    date: isoDate(r["Transaction Date"]),
    merchant,
    amount: Math.abs(raw),
    kind,
    bankCategory: r["Category"] ?? "",
  };
}

function wellsFargo(r: Record<string, string>): Draft {
  const raw = Number(r["AMOUNT"]);
  const merchant = cleanMerchant(r["DESCRIPTION"]);
  const kind: Kind = PAYMENT.test(merchant) ? "payment" : raw < 0 ? "sale" : "refund";
  return { date: isoDate(r["DATE"]), merchant, amount: Math.abs(raw), kind, bankCategory: "" };
}

function discover(r: Record<string, string>): Draft {
  const raw = Number(r["Amount"]);
  const category = r["Category"] ?? "";
  const merchant = cleanMerchant(r["Description"]);
  let kind: Kind;
  if (/Payments and Credits/i.test(category) && PAYMENT.test(merchant)) kind = "payment";
  else if (/Rebate|Awards/i.test(category)) kind = "cashback";
  else kind = raw > 0 ? "sale" : "refund";
  return { date: isoDate(r["Trans. Date"]), merchant, amount: Math.abs(raw), kind, bankCategory: category };
}

function amex(r: Record<string, string>): Draft {
  const raw = Number(r["Amount"]);
  const merchant = cleanMerchant(r["Description"]);
  let kind: Kind;
  let creditFor: string | undefined;
  if (raw > 0) kind = /ANNUAL FEE|MEMBERSHIP FEE/i.test(merchant) ? "fee" : "sale";
  else if (PAYMENT.test(merchant)) kind = "payment";
  else if (/credit/i.test(merchant)) {
    kind = "credit";
    // Extended Details opens with the merchant the credit was earned on.
    creditFor = cleanMerchant((r["Extended Details"] ?? "").split("\n")[0] ?? "");
  } else kind = "refund";
  return {
    date: isoDate(r["Date"]),
    merchant,
    amount: Math.abs(raw),
    kind,
    bankCategory: r["Category"] ?? "",
    creditFor,
  };
}

/** Normalize one exported file. Rows before `since` (YYYY-MM-DD) are dropped. */
export function normalizeFile(name: string, text: string, since = "2026-01-01"): BankRow[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  let read: (r: Record<string, string>) => Draft;
  if (cols.includes("Transaction Date") && cols.includes("Type")) read = chase;
  else if (cols.includes("DESCRIPTION") && cols.includes("AMOUNT")) read = wellsFargo;
  else if (cols.includes("Trans. Date")) read = discover;
  else if (cols.includes("Card Member") || cols.includes("Extended Details")) read = amex;
  else throw new Error(`${name}: unrecognized CSV columns ${cols.join(", ")}`);

  const card = cardFromFilename(name);
  return rows
    .map((r, i) => ({ id: `${card}#${i}`, card, ...read(r) }))
    .filter((r) => r.date >= since && r.amount > 0);
}
