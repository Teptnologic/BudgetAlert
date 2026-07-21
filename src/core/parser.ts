// Bank-alert parser. Pure & host-agnostic — no Worker/D1 imports so it can be
// unit-tested directly. Given the text of an email (subject + body), it returns
// a parsed transaction or `null` when the message is not a spend alert.
//
// Adding a bank is usually just confirming its alert wording matches the
// generic patterns below; add a dedicated rule to BANK_RULES if it doesn't.

export interface ParsedTxn {
  amount: number;
  merchant: string | null;
  currency: string | null;
}

// Messages that mention money but are NOT outgoing spend — skip these so we
// never count income, refunds, declines, statements, or one-time codes.
const NON_SPEND = /\b(refund|credited|credit\s+of|received|reversal|reversed|declined|statement|balance\s+is|one[-\s]?time\s+code|verification\s+code|otp|password)\b/i;

// At least one of these must be present for us to treat a message as a spend.
const SPEND_HINT = /\b(spent|purchase|purchased|charged|debited|transaction|paid|payment\s+of|withdrawn|withdrawal|deducted)\b/i;

const CURRENCY_SYMBOL: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
};

interface Rule {
  name: string;
  extract: (text: string) => ParsedTxn | null;
}

// Pull the first monetary amount, supporting "$42.10", "USD 42.10", "42.10 GBP".
function findAmount(text: string): { amount: number; currency: string | null } | null {
  const symbolFirst = text.match(/(USD|GBP|EUR|\$|£|€)\s?([0-9](?:[0-9,]*)(?:\.[0-9]{1,2})?)/i);
  if (symbolFirst) {
    return {
      amount: toNumber(symbolFirst[2]),
      currency: normalizeCurrency(symbolFirst[1]),
    };
  }
  const numberFirst = text.match(/\b([0-9](?:[0-9,]*)(?:\.[0-9]{1,2})?)\s?(USD|GBP|EUR)\b/i);
  if (numberFirst) {
    return {
      amount: toNumber(numberFirst[1]),
      currency: normalizeCurrency(numberFirst[2]),
    };
  }
  return null;
}

function findMerchant(text: string): string | null {
  // "... at TESCO on ..." / "... at AMAZON.COM." / "... to NETFLIX"
  // Allow dots inside the name (AMAZON.COM) but stop at a trailing sentence
  // period, other punctuation, or a following clause word (was/is/on/for/…).
  const m = text.match(
    /\b(?:at|to)\s+([A-Za-z0-9][A-Za-z0-9 &'*.\-]{1,40}?)(?=\s+(?:on|for|using|with|via|by|was|is|were|has|have|and)\b|[,;!]|\.\s|\.?$)/i,
  );
  if (!m) return null;
  const merchant = m[1].trim().replace(/\s+/g, " ").replace(/\.+$/, "");
  return merchant.length ? merchant : null;
}

function toNumber(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

function normalizeCurrency(token: string): string | null {
  const upper = token.toUpperCase();
  if (upper === "USD" || upper === "GBP" || upper === "EUR") return upper;
  return CURRENCY_SYMBOL[token] ?? null;
}

// Generic rule that handles the vast majority of bank alert formats.
const genericRule: Rule = {
  name: "generic",
  extract(text) {
    if (NON_SPEND.test(text)) return null;
    if (!SPEND_HINT.test(text)) return null;
    const money = findAmount(text);
    if (!money || !Number.isFinite(money.amount) || money.amount <= 0) return null;
    return {
      amount: money.amount,
      merchant: findMerchant(text),
      currency: money.currency,
    };
  },
};

// Chase alerts read: "You made a $10.46 transaction with MERCHANT on <date>".
// The generic rule gets the amount but misses the merchant (Chase uses "with",
// not "at"), so handle Chase explicitly.
const chaseRule: Rule = {
  name: "chase",
  extract(text) {
    if (NON_SPEND.test(text)) return null;
    const m = text.match(
      /you made a\s+\$?([0-9](?:[0-9,]*)(?:\.[0-9]{1,2})?)\s+transaction(?:\s+with\s+(.+?))?(?=\s+on\b|[.,;!]|$)/i,
    );
    if (!m) return null;
    const amount = toNumber(m[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    let merchant = m[2]?.trim().replace(/\s+/g, " ") ?? null;
    // Guard against "...transaction with your Freedom card" style phrasing.
    if (merchant && /^your\b/i.test(merchant)) merchant = null;
    return { amount, merchant: merchant || null, currency: "USD" };
  },
};

// Bank-specific rules run first; add entries here for banks whose wording the
// generic rule mis-parses. Each returns a ParsedTxn or null.
const BANK_RULES: Rule[] = [chaseRule];

export function parseTransaction(rawText: string): ParsedTxn | null {
  const text = (rawText ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  for (const rule of [...BANK_RULES, genericRule]) {
    const result = rule.extract(text);
    if (result) return result;
  }
  return null;
}
