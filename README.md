# BudgetAlert

A personal budget bot that runs on **Cloudflare Workers + D1**. It captures your
spending from the transaction-alert emails your bank already sends, tracks it
against a budget, and:

- 🚨 **Alerts** a Telegram group the moment you cross a threshold (e.g. 80% and 100%)
- 📊 Posts a **weekly summary** on a schedule
- 💬 Answers **on-demand checks** — message `/status` in the group to see what's left
- 🗂 Tracks **budget envelopes** — a yearly gift budget separate from your weekly spend
- 📈 Reports a whole **week, month, quarter or year** — on demand, and posted
  automatically when a quarter or a year closes
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
| `src/core/period.ts` | Week/month/quarter/year period boundaries, in a real timezone |
| `src/core/schedule.ts` | Which job a cron firing is asking for |
| `src/service.ts` | Ties core → storage → Telegram (the shared pipeline) |
| `src/store/d1.ts` | D1 data layer (the only DB-specific module) |
| `src/notify/telegram.ts` | Delivery channel |
| `src/email/inbound.ts` | Cloudflare Email Worker handler |
| `src/telegram/commands.ts` | Slash commands, @mention routing, confirmation taps |
| `src/nl/schema.ts` | Intent JSON schema + normalization |
| `src/nl/interpret.ts` | Claude API call — classification only, never touches D1 |
| `src/nl/execute.ts` | Reads (status, history, reports) + staging writes for confirmation |
| `src/nl/plan.ts` | Dry-run validation of a batch, then applying the approved plan |
| `src/nl/resolve.ts` | Which transaction each selector in a batch means |
| `src/router.ts` | HTTP routes: `/telegram`, `/inbound`, health |
| `src/index.ts` | Worker entry: `email`, `fetch`, `scheduled` (digest + period reports) |

## Natural language

@-mention the bot in the group (or reply to one of its messages) and say what you
mean:

```
@budgetbot I spent $12 on lunch yesterday
@budgetbot move the last $200 charge into yearly gift budget
@budgetbot create a yearly gift budget of 1200
@budgetbot change the last charge to $48.60
@budgetbot delete the last charge
@budgetbot move the last charge back to my main budget
@budgetbot delete the gift budget
@budgetbot how did last quarter go?
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

Removing one (`delete the last charge`, `remove the $12 coffee`) is for a record
that shouldn't exist at all — a charge that was never yours, or the same spend
captured twice. Nothing restores the row afterwards. Every action that touches an
existing charge names the row it actually landed on rather than repeating the
selector back — "Most recent charge" and "The $0.01 charge" don't say *which*
charge, and approving one of those is a blind approval:

```
Confirm this?

Remove transaction
Which charge  Most recent charge
Removing      $200.00 — TOP GOLF BAY RESERVA (07-22)
                          [✅ Yes]  [✖️ No]
```

The row is deleted outright, dedupe hash and all — so if the bank re-sends that
same alert it will be captured again. "Remove" means the record was wrong, not
"never accept this alert".

Anything that changes data shows a summary with **Yes / No** buttons and only
applies on tap, so a misread amount can't silently move money. The charge named
in that summary is **pinned**: approving acts on that exact row, not on whatever
the selector matches a second time.

### When a selector matches more than one charge

Selectors are your own words, and they routinely fit several rows — one merchant
name can be a prefix of another (`FD *CA DMV 640` and `FD *CA DMV 640 *SVC`), and
every $0.01 pre-authorization hold looks like every other one. Rather than taking
the newest match and hoping, the bot asks:

```
Which charge did you mean?

Correct amount — ⚠️ 2 transactions matching "DMV" — which one?
Which charge  Matching "DMV"
New amount    $616.00
Option 1      $0.01 — FD *CA DMV 640 *SVC (09-06)
Option 2      $0.01 — FD *CA DMV 640 (09-06)
                  [1. $0.01 — FD *CA DMV 640 *SVC (09-06)]
                  [2. $0.01 — FD *CA DMV 640 (09-06)]
                  [✖️ None of these]
```

Answering pins that row and re-plans the message, which turns the question into
the ordinary confirmation — the rest of the batch is carried along, so you never
retype it. Past a handful of matches it asks you to narrow the selector instead
of listing them all.

Selectors are resolved for the message **as a whole**, not left to right, so a
step whose selector names exactly one charge claims it before a vaguer step can:
*"change FD \*CA DMV 640 to $616, change FD \*CA DMV 640 \*SVC to $12.94"* gives
each step its own charge, and an exact merchant match outranks the longer names
it appears inside.

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

Charges move both ways. *"move the last $200 charge into yearly gift budget"*
files one into an envelope; *"move the last charge back to my main budget"*
takes it back out, and the confirmation names the envelope it's leaving so you
can see it landed on the right charge.

Deleting an envelope (*"delete the gift budget"*) **keeps the spending** — its
charges return to the main budget, where they start counting against your weekly
total again, and the confirmation tells you how many and how much before you
tap. Destroying the charges as well takes an explicit ask:

```
@budgetbot delete the gift budget and everything in it
```

That distinction is the point. A misparse of *"delete the gift budget"* costs you
an envelope you can recreate; it can't cost you months of transaction history.

## Reports

`/report` gives an aggregated summary of one whole calendar period — the main
budget's progress, every envelope, and the biggest merchants — rather than a
list of rows:

```
/report            → this month
/report quarter    → this quarter
/report year last  → last year
/report month 2    → two months back
```

```
📊 Q3 2026 so far

Main budget
██████░░░░ 60%
Spent: $300.00 of $500.00 across 2 transactions
Remaining: $200.00

Envelopes
• Gift: $50.00 across 1 transaction

Biggest merchants
• $300.00 — COSTCO (2×)
• $50.00 — GIFT SHOP

Everything together: $350.00 across 3 transactions
```

In natural language, *"how did last quarter go?"* or *"give me a yearly report"*
does the same.

### Reports that arrive on their own

Two of them are also posted to the group on a schedule, alongside the weekly
digest:

| Cron | When | What arrives |
|---|---|---|
| `0 16 * * SUN` | Sunday ~9am Pacific | Weekly digest |
| `0 17 1 1,4,7,10 *` | Jan/Apr/Jul/Oct 1st | Report on the quarter that just ended |
| `0 18 1 1 *` | Jan 1st | Report on the year that just ended |

Each fires on the **first day of the new period and reports the previous one** —
a quarterly report sent on Oct 1 covers Q3, not the six hours of Q4 that exist
by then. Jan 1 matches both report crons, so their hours are staggered an hour
apart rather than racing.

`src/core/schedule.ts` decides which report a firing wants from the *shape* of
the cron expression, not its exact text, so shifting an hour doesn't silently
turn a yearly report back into a weekly digest. Delete a line from
`[triggers] crons` to turn one off; `0 17 1 * *` would add a monthly one.

A period with no spending at all sends nothing — a quiet quarter shouldn't post
"Nothing recorded" to the group. Asking directly still answers.

Scheduled reports involve no model call, so they work without
`ANTHROPIC_API_KEY`.

The budget line only appears when the report covers the same cadence your budget
resets on. `$300.00 of $500.00` is a fact about a week and nonsense about a
quarter — thirteen weekly budgets aren't one quarterly limit — so a mismatched
report shows the total and says why there's nothing to compare it against. The
same rule governs each envelope's limit.

**A report is not `/history`.** `/history` prints every transaction, which is
right for a week and unusable for a year in a chat message. Ask for a report when
you want the shape of a period, and a history when you want the rows.

## Spending history

`/history` lists this week's spending against the main budget; `/history last`
steps back a week, `/history 3` three weeks. In natural language, *"show my
spending last week"* does the same, and you can ask for a month, a year, or one
envelope.

```
main budget — last week (week of 2026-07-20)
07-22  $95.00 — PETROL
07-23  $30.00 — CINEMA
Total: $125.00 across 2 transactions
```

**Only main-budget spending is counted by default.** Because envelopes are
exclusive, money filed into a named envelope isn't weekly spending — a $166.67
water heater charged to the gift budget stays out of the weekly total. Ask for
`everything` to see both together, or name an envelope to see just that one.

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
/report quarter  → summarizes the quarter so far
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
| `BUDGET_PERIOD` | `weekly` | `weekly`, `monthly`, `quarterly`, or `yearly` budget window |
| `TIMEZONE` | `America/Los_Angeles` | IANA zone all budget periods are computed in |
| `WEEK_START` | `sunday` | `sunday` or `monday` — which day a budget week begins |
| `TELEGRAM_BOT_USERNAME` | — | Your bot's handle, for @mention detection |
| `NL_MODEL` | `claude-sonnet-5` | Model used to parse natural language |

`NL_MODEL` defaults to Sonnet 5 rather than Opus 5 on purpose: this is bounded
extraction on a latency-sensitive webhook path, and compiled grammars are cached
only ~24h from last use — a low-traffic personal bot would often pay Opus
compile latency for no accuracy gain. Switch it if you disagree.

Schedules live in `[triggers] crons` — the weekly digest plus the quarterly and
yearly reports. See [Reports that arrive on their own](#reports-that-arrive-on-their-own).
Cron is always UTC, so the local hour shifts by one across daylight saving.

### Weeks and timezones

Budget periods are computed in `TIMEZONE`, **not UTC**, and weeks begin on
`WEEK_START`. This is not cosmetic: on UTC, a Saturday-evening dinner in
California is already Sunday, so it would file into the following week and
vanish from the week you actually spent it. Daylight saving is handled — period
boundaries land on local midnight on both sides of a change, not 168 hours
apart — and transaction dates are displayed as local days for the same reason.

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
