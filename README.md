# BudgetAlert

A personal budget bot that runs on **Cloudflare Workers + D1**. It captures your
spending from the transaction-alert emails your bank already sends, tracks it
against a budget, and:

- 🚨 **Alerts** a Telegram group the moment you cross a threshold (e.g. 80% and 100%)
- 📊 Posts a **weekly summary** on a schedule
- 💬 Answers **on-demand checks** — message `/status` in the group to see what's left

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
| `src/telegram/commands.ts` | `/status`, `/budget`, `/setgroup`, `/help` |
| `src/router.ts` | HTTP routes: `/telegram`, `/inbound`, health |
| `src/index.ts` | Worker entry: `email`, `fetch`, `scheduled` |

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

### 3. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Store secrets:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any long random string
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
| `BUDGET_PERIOD` | `monthly` | `monthly` or `weekly` budget window |

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
