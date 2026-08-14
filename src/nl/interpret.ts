// Turns a plain-English Telegram message into a structured Intent via the
// Claude API. This module NEVER touches the database — it only classifies. All
// execution happens in execute.ts through typed handlers, so a misparse can
// produce a wrong-but-valid action, never an arbitrary one.

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { INTENT_SCHEMA, MAX_ACTIONS, normalizeBatch, unknownIntent, type Intent } from "./schema";

// Sonnet 5 is the default rather than Opus 5: this is a bounded extraction task
// on a latency-sensitive webhook path, and compiled grammars are cached for 24h
// from last use — a low-traffic personal bot frequently falls outside that
// window and pays compilation on the request. Override with the NL_MODEL var.
const DEFAULT_MODEL = "claude-sonnet-5";

// Generous on purpose. Thinking is billed against max_tokens along with the
// response text, so a tight cap (the tempting `256` for a small JSON object)
// truncates mid-object: stop_reason "max_tokens" and unparseable output.
const MAX_TOKENS = 4096;

export interface InterpretContext {
  categories: { name: string; label: string; amount: number; period: string }[];
  recent: { amount: number; merchant: string | null; occurredAt: string }[];
  currency: string;
}

function systemPrompt(ctx: InterpretContext): string {
  const cats = ctx.categories.length
    ? ctx.categories
        .map((c) => `- ${c.name} ("${c.label}") — ${c.amount} ${ctx.currency} per ${c.period}`)
        .join("\n")
    : "(none yet)";

  const recent = ctx.recent.length
    ? ctx.recent
        .map(
          (t, i) =>
            `${i + 1}. ${t.amount} ${ctx.currency} — ${t.merchant ?? "unknown"} (${t.occurredAt.slice(0, 10)})`,
        )
        .join("\n")
    : "(none yet)";

  const today = new Date();
  const weekday = today.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

  return [
    "You classify messages sent to a personal budget bot into a single structured intent.",
    "",
    `Today is ${weekday}, ${today.toISOString().slice(0, 10)} (UTC). Budget weeks run Monday to Sunday.`,
    "",
    "Existing budget categories (envelopes):",
    cats,
    "",
    "Most recent transactions, newest first:",
    recent,
    "",
    "Rules:",
    "- Match the user's wording to an EXISTING category name when they plainly mean it.",
    "  'yearly gift budget' should resolve to an existing 'gift' category rather than a new one.",
    "- Use create_category only when no existing category fits.",
    "- 'the last charge' means the most recent transaction: selector_kind 'last'.",
    "- To record spending the bank never emailed about (cash, a split bill), use",
    "  add_transaction with amount, merchant, and days_ago (0 = today, 1 = yesterday).",
    "  'I spent $12 on lunch yesterday' → add_transaction, amount 12, merchant 'lunch',",
    "  days_ago 1. Only set category if the user names an existing envelope.",
    "- 'add a spending of $166.67 for a water heater to the gift budget' is an",
    "  add_transaction: amount 166.67, merchant 'water heater', category 'gift'. Adding",
    "  spending TO an envelope files a charge against it. Only use set_budget when the",
    "  user is changing the envelope's LIMIT ('set the gift budget to 1200').",
    "- To correct a captured amount (bank alerts often land pre-tip), use",
    "  set_transaction_amount: the selector picks the transaction, new_amount is what it",
    "  becomes. 'change the $84 charge to $48' → selector_kind 'amount', amount 84,",
    "  new_amount 48. Do not confuse this with move_transaction, which changes the",
    "  envelope and never the amount.",
    "- Fields that do not apply take their empty value: \"\" for text, 0 for numbers,",
    "  'none' for period/window/selector_kind.",
    "- If the message is ambiguous, off-topic, or you would have to guess at an amount",
    "  or a category, return a single action 'unknown' with a short reason. Guessing moves",
    "  the user's money to the wrong place; asking is always cheaper.",
    "",
    "Spending history:",
    "- list_transactions shows a history. Set window to 'week', 'month', or 'year' for a",
    "  whole calendar period, with period_offset 0 for the current one, 1 for the",
    "  previous, and so on. 'my spending this week' → window 'week', period_offset 0;",
    "  'last week' → period_offset 1. Use window 'none' with limit N for a plain",
    "  'show my last N transactions' with no date range.",
    "- scope decides what counts. 'main' is the main weekly budget on its own and is the",
    "  right default — money filed into a named envelope is not weekly spending. Use",
    "  'category' with a category name when they ask about one envelope, and 'all' only",
    "  when they explicitly want everything together.",
    "",
    "Multiple actions:",
    `- Return one action per distinct thing the user asked for, at most ${MAX_ACTIONS},`,
    "  in the order they said them. Most messages are a single action.",
    "- A later action may depend on an earlier one. 'create a yearly gift budget of 1200",
    "  and move the last $200 charge into it' is exactly two actions: create_category",
    "  then move_transaction, both with category 'gift'. Do not drop either half.",
    "- Do not invent steps the user did not ask for, and do not split one request into",
    "  several. When in doubt, prefer a single 'unknown' over a speculative multi-step plan.",
  ].join("\n");
}

export async function interpret(
  env: Env,
  message: string,
  ctx: InterpretContext,
): Promise<Intent[]> {
  if (!env.ANTHROPIC_API_KEY) {
    return [unknownIntent("Natural language is not configured (no API key set).")];
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  try {
    const response = await client.messages.create({
      model: env.NL_MODEL || DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      // Adaptive thinking is left on because it is the recommended default and
      // costs little at low effort — not because disabling it would corrupt the
      // structured output. The grammar constrains the response body regardless.
      thinking: { type: "adaptive" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: INTENT_SCHEMA },
      },
      system: systemPrompt(ctx),
      messages: [{ role: "user", content: message }],
    });

    // Safety classifiers can decline: HTTP 200 with an empty/partial content array.
    if (response.stop_reason === "refusal") {
      return [unknownIntent("That request was declined.")];
    }
    // Truncation leaves invalid JSON. Treat it as a miss rather than parsing junk.
    if (response.stop_reason === "max_tokens") {
      console.error("interpret: response truncated at max_tokens");
      return [unknownIntent("That took too long to work out — try rephrasing more simply.")];
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text.trim()) return [unknownIntent("I got an empty response — try rephrasing.")];

    return normalizeBatch(JSON.parse(text));
  } catch (err) {
    // Log the status and body — a bare "couldn't process that" tells neither
    // the user nor `wrangler tail` anything actionable.
    const status = (err as { status?: number })?.status;
    console.error("interpret error:", status ?? "", (err as Error)?.message ?? err);

    // Configuration faults are worth naming: they don't resolve by retrying,
    // and only the operator can fix them.
    if (status === 401 || status === 403) {
      return [unknownIntent("My API key is being rejected — check ANTHROPIC_API_KEY.")];
    }
    if (status === 400) {
      return [unknownIntent("The model rejected that request — see `wrangler tail` for details.")];
    }
    if (status === 429) {
      return [unknownIntent("Rate limited just now — try again in a moment.")];
    }
    if (status === 404) {
      return [unknownIntent(`Model "${env.NL_MODEL || DEFAULT_MODEL}" wasn't found — check NL_MODEL.`)];
    }
    return [unknownIntent("I couldn't process that just now.")];
  }
}
