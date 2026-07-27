// Turns a plain-English Telegram message into a structured Intent via the
// Claude API. This module NEVER touches the database — it only classifies. All
// execution happens in execute.ts through typed handlers, so a misparse can
// produce a wrong-but-valid action, never an arbitrary one.

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { INTENT_SCHEMA, normalizeIntent, unknownIntent, type Intent } from "./schema";

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

  return [
    "You classify messages sent to a personal budget bot into a single structured intent.",
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
    "- Fields that do not apply take their empty value: \"\" for text, 0 for numbers,",
    "  'none' for period/window/selector_kind.",
    "- If the message is ambiguous, off-topic, or you would have to guess at an amount",
    "  or a category, return action 'unknown' with a short reason. Guessing moves the",
    "  user's money to the wrong place; asking is always cheaper.",
  ].join("\n");
}

export async function interpret(
  env: Env,
  message: string,
  ctx: InterpretContext,
): Promise<Intent> {
  if (!env.ANTHROPIC_API_KEY) {
    return unknownIntent("Natural language is not configured (no API key set).");
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
      return unknownIntent("That request was declined.");
    }
    // Truncation leaves invalid JSON. Treat it as a miss rather than parsing junk.
    if (response.stop_reason === "max_tokens") {
      console.error("interpret: response truncated at max_tokens");
      return unknownIntent("That took too long to work out — try rephrasing more simply.");
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text.trim()) return unknownIntent("I got an empty response — try rephrasing.");

    return normalizeIntent(JSON.parse(text));
  } catch (err) {
    console.error("interpret error:", err);
    return unknownIntent("I couldn't process that just now.");
  }
}
