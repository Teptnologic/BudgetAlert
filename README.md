# BudgetAlert

A personal budget bot that runs on **Cloudflare Workers + D1**. It captures your
spending from the transaction-alert emails your bank already sends, tracks it
against a budget, and:

- 🚨 **Alerts** a Telegram group the moment you cross a threshold (e.g. 80% and 100%)
- 📊 Posts a **weekly summary** on a schedule
- 💬 Answers **on-demand checks** — message `/status` in the group to see what's left
- 🗂 Tracks **budget envelopes** — a yearly gift budget separate from your weekly spend
- 🗣 Understands **plain English** — `@bot move the last $200 charge into yearly gift budget`

No bank credentials, no Plaid, nothing to poll. Bank alert → email → Worker.

## How it works

```
Bank transaction alert (email)
  → forwarded to the Worker's address (Cloudflare Email Routing)
  → email() handler parses amount + merchant  (src/core/parser.ts)
  → stored in D1, running total compared to budget  (src/core/engine.ts)
  → threshold crossed?  → message posted to the Telegram group
  ─────────────────────────────────────────────────────────────
  weekly cron  → scheduled() posts a summary to the group
  /status in the group → fetch() replies with remaining budget
```

The core (parser, budget engine, period math) is plain, host-agnostic
TypeScript with unit tests. Only `src/store/d1.ts`, `src/notify/telegram.ts`,
and the entry points are Cloudflare-specific — so moving to a plain server or a
different chat platform later means swapping an adapter, not a rewrite.

## Project layout

| Path | What it does |
|---|---|
| `src/core/parser.ts` | Turns an alert email into `{ amount, merchant, currency }` or `null` |
| `src/core/engine.ts` | Budget status + which threshold alerts to fire |
| `src/core/period.ts` | Monthly/weekly period boundaries |
| `src/service.ts` | Ties core → storage → Telegram (the shared pipeline) |
| `src/store/d1.ts` | D1 data layer (the only DB-specific module) |
| `src/notify/telegram.ts` | Delivery channel |
| `src/email/inbound.ts` | Cloudflare Email Worker handler |
| `src/telegram/commands.ts` | Slash commands, @mention routing, confirmation taps |
| `src/nl/schema.ts` | Intent JSON schema + normalization |
| `src/nl/interpret.ts` | Claude API call — classification only, never touches D1 |
| `src/nl/execute.ts` | Intent → typed handlers, confirm-then-apply |
| `src/router.ts` | HTTP routes: `/telegram`, `/inbound`, health |
| `src/index.ts` | Worker entry: `email`, `fetch`, `scheduled` |

## Natural language

@-mention the bot in the group (or reply to one of its messages) and say what you
mean:

```
@budgetbot I spent $12 on lunch yesterday
@budgetbot move the last $200 charge into yearly gift budget
@budgetbot create a yearly gift budget of 1200
@budgetbot change the last charge to $48.60
@budgetbot how much did I spend on gifts this year?
@budgetbot set my weekly budget to 400
```

Every confirmation spells out how the message was understood, field by field, so
a misparse is visible before you approve it rather than after:

```
Confirm this?

Add transaction
Amount    $12.00
Merchant  lunch
When      Yesterday
Budget    Main budget
                          [✅ Yes]  [✖️ No]
```

A batch numbers each step the same way. The fields matter most where two similar
numbers appear in one sentence — "change the $84 charge to $48" renders as
`Which charge → The $84.00 charge` and `New amount → $48.60`, so a swap is
obvious at a glance.

`add_transaction` covers spending the bank never emails about — cash, a split
bill, a card whose alerts aren't wired up. It records against today unless you
say otherwise ("yesterday", "3 days ago"), and can file straight into an
envelope.

One message can carry several actions, and later ones can depend on earlier ones
— *"create a yearly gift budget of 1200 and move the last $200 charge into it"*
is planned as two steps and confirmed together. If any step is invalid, none of
them run.

Correcting an amount (`change the last charge to $48.60`) is for when the captured
figure is wrong — bank alerts frequently land pre-tip. Budget totals are summed
live, so every status recomputes on the next read.

Anything that changes data shows a summary with **Yes / No** buttons and only
applies on tap, so a misread amount can't silently move money.

**How it's kept safe:** the model only classifies a message into a structured
intent (`{action, category, amount, …}`). It never writes SQL and never sees the
database — execution runs through typed handlers in `src/nl/execute.ts`. A
misparse can produce a wrong-but-valid action, never an arbitrary one.

The intent schema is deliberately **one flat object with every field required and
no unions**. The API caps a request at 24 optional parameters and 16 using
`anyOf`/type arrays; over the grammar's limits it returns a 400 "Schema is too
complex for compilation" — which would land on a user's message, not at build
time. `test/nl.test.ts` asserts those counts so a future field can't quietly push
it over.

Natural language is **optional**. Without `ANTHROPIC_API_KEY` the slash commands
work exactly as before.

## Budget envelopes

Envelopes are **exclusive**: a transaction counts toward exactly one budget.
Moving a $200 charge into `gift` removes it from your weekly budget, so weekly
remaining goes *up* by $200. Uncategorized spend is the default budget.

Threshold alerts fire on the default envelope only — a yearly gift budget
shouldn't trip a weekly warning. `/categories` lists envelopes and their spend.

## Setup

### 1. Install & test

```bash
npm install
npm test        # runs the core unit tests
```

### 2. Create the D1 database

```bash
npx wrangler d1 create budgetalert
# paste the printed database_id into wrangler.toml
npm run db:init          # applies schema.sql to the remote DB
```

> **Upgrading an existing database?** `db:init` is re-runnable but won't add the
> new columns. Run the migration once instead:
> ```bash
> npm run db:migrate          # adds categories, transactions.category_id, pending_actions
> ```
> It is *not* idempotent (`ALTER TABLE ADD COLUMN`) — run it exactly once.

### 3. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Send BotFather `/setprivacy` → your bot → **Disable**, so it can read group
   messages that mention it.
3. Put your bot's handle in `wrangler.toml` as `TELEGRAM_BOT_USERNAME` (without
   the `@`) — that's how the Worker knows it was addressed.
4. Store secrets:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any long random string
   npx wrangler secret put ANTHROPIC_API_KEY         # optional — enables @mentions
   ```

### 4. Deploy

```bash
npm run deploy
# note the deployed URL, e.g. https://budgetalert.<subdomain>.workers.dev
```

### 5. Point Telegram at the Worker

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://budgetalert.<subdomain>.workers.dev/telegram" \
  -d "secret_token=<your TELEGRAM_WEBHOOK_SECRET>"
```

Then add the bot to your group and send:

```
/setgroup        → registers the group for alerts & the weekly summary
/budget 500      → sets your budget
/status          → shows what's left
```

### 6. Route your bank alerts to the Worker

In the Cloudflare dashboard → **Email → Email Routing**, create an address on
your domain (e.g. `spend@yourdomain.com`) and set its action to **Send to a
Worker → budgetalert**. Then, in your bank's app, turn on transaction alerts and
set the destination to that address (directly, or auto-forwarded from your
inbox).

> **No domain yet?** Use the generic webhook instead: `POST /inbound` with
> `{ "subject": "...", "text": "..." }`. Point a service like Mailgun/SendGrid
> Inbound Parse at `https://…workers.dev/inbound`. Same pipeline.

## Configuration

`wrangler.toml` `[vars]`:

| Var | Default | Meaning |
|---|---|---|
| `WARN_PCT` | `80` | First alert at this % of budget |
| `ALERT_PCT` | `100` | Second alert at this % of budget |
| `CURRENCY` | `USD` | Default currency when an alert omits one |
| `BUDGET_PERIOD` | `weekly` | `weekly`, `monthly`, or `yearly` budget window |
| `TELEGRAM_BOT_USERNAME` | — | Your bot's handle, for @mention detection |
| `NL_MODEL` | `claude-sonnet-5` | Model used to parse natural language |

`NL_MODEL` defaults to Sonnet 5 rather than Opus 5 on purpose: this is bounded
extraction on a latency-sensitive webhook path, and compiled grammars are cached
only ~24h from last use — a low-traffic personal bot would often pay Opus
compile latency for no accuracy gain. Switch it if you disagree.

Weekly-summary schedule lives in `[triggers] crons` (default: Monday 09:00 UTC).

## Adding a bank

Most alert formats are handled by the generic parser. If a bank's wording parses
wrong, add a rule to `BANK_RULES` in `src/core/parser.ts` and a case to
`test/parser.test.ts` with a sample of that bank's alert.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in token + secret
npm run db:init:local
npm run dev
```
