// Cloudflare Email Worker handler. When a bank alert is routed to the Worker's
// address, this parses it and runs the budget pipeline. Non-spend emails are
// silently ignored.

import PostalMime from "postal-mime";
import type { Env } from "../env";
import { parseTransaction } from "../core/parser";
import { recordAndEvaluate } from "../service";

interface EmailMessage {
  raw: ReadableStream;
  from: string;
  to: string;
}

export async function handleEmail(message: EmailMessage, env: Env): Promise<void> {
  const buf = await new Response(message.raw).arrayBuffer();
  const email = await PostalMime.parse(buf);

  const subject = email.subject ?? "";
  const body = email.text ?? stripHtml(email.html ?? "");
  const parsed = parseTransaction(subject, body);
  if (!parsed) return;

  const occurredAt = (email.date ? new Date(email.date) : new Date()).toISOString();
  await recordAndEvaluate(env, parsed, occurredAt, "email");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}
