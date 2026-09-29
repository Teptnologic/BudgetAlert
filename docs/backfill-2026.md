# 2026 history backfill — ops note

A one-time operation, run 2026-09-28/29. The bot only started tracking
spending from its first alert on 2026-07-20, so January–September 2026 was
backfilled from card statement exports. **From here on, spending is tracked
through alerts only; this is not a recurring job.**

## What was done

1. **Exported statements**, Jan 1 – Sep 27 2026, for 8 cards: Chase …1714,
   …2992, …4443, …7923 and …7212, Wells Fargo, Discover, and AMEX. The AMEX
   export only covered 09/22–09/26.
2. **Exported D1** (`transactions` + `categories`) with `wrangler d1 execute --json`.
3. **Ran the reconcile** (`npm run reconcile`, `scripts/reconcile/`) to get a
   keyed preview (`proposed-changes.{md,csv}`) and `reconcile.sql`:
   - **Refunds:** fully refunded purchases were excluded. Partial refunds and
     card-benefit credits (Uber One, dining, StubHub, travel, The Edit, AMEX
     Platinum credits) left the purchase at its net amount.
   - **Ignored:** payments, "Offer:" cashback and Discover rebates.
   - **Counted:** annual fees.
   - **Already in D1:** rows that D1 already held in another shape kept D1's
     version. That covered split DoorDash alerts, manual roll-ups, half-share
     amounts and tip-adjusted amounts.
   - **Fixed:** $0.01 pre-auth holds became the posted charge or were removed.
     A correction that had landed on the wrong row was moved back.
4. **Dry-ran it on a local D1** seeded from the export. The first apply
   brought the table from 198 rows to 776. Applying it a second time changed
   nothing.
5. **Applied it to remote D1:** 581 inserts, 5 updates and 3 deletes.
6. **Re-filed envelopes.** A draft of suggested envelope moves was reviewed
   in a spreadsheet. The user's edits produced a second SQL file
   (`envelope-moves.sql`), which was dry-run locally the same way and then
   applied:
   - **New envelopes:** Insurance ($5,000/yr), 2026Moving ($3,900/yr) and
     Credit Card Fee ($890/yr).
   - **164 envelope moves.** Chase Travel and Ikon Pass went to Travel,
     insurance to Insurance, the January move to 2026Moving, and so on.
   - **59 deletes** of spending that shouldn't count against the budget.
     This covered reimbursed work trips and allowance-covered meals, FSA
     spending, shipping costs for items sold, purchases made for others, a
     duplicate manual row, and refunds the statements didn't show.
   - **2 amount corrections and 1 rename.**
   - **Result:** 717 rows.

Remote backups were taken before each apply. Every data file stayed off git:
the statements, D1 exports, generated SQL and CSVs, and backups.

## If you ever run the reconcile again

- **Don't run it over Jan–Sep 2026.** The 59 deleted rows were imported rows.
  `INSERT OR IGNORE` can't tell a deleted row from one that was never
  inserted, so it would bring them back. Restrict a later run with
  `--since YYYY-MM-DD`.
- **Take a fresh D1 export first.** The reconcile matches statement rows
  against whatever D1 holds at that moment.

## Known gaps in alert coverage

These are the reasons the backfill found spending the alerts missed:

- **Discover:** there's no alert parser, so Discover spending isn't captured.
- **AMEX:** only "Large Purchase Approved" alerts are parsed, so small AMEX
  charges aren't captured.
- **Wells Fargo:** alerts started 2026-08-14. Earlier charges came only from
  the backfill.
