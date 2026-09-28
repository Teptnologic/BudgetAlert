import { describe, it, expect } from "vitest";
import { normalizeFile, parseCsv, type BankRow } from "../scripts/reconcile/normalize";
import { applyRefunds, merchantKey } from "../scripts/reconcile/refunds";
import { merchantSimilarity, parseD1Export, reconcile, type D1Txn } from "../scripts/reconcile/diff";
import { emitSql, occurredAt, parseSkip, planChanges, renderSql } from "../scripts/reconcile/emit-sql";
import { localDayIso } from "../src/core/period";
import { changeToTotal, renderChangesCsv } from "../scripts/reconcile/report";

const CHASE = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
09/22/2026,09/22/2026,LIMELIGHT MAMMOTH FRON,Travel,Return,368.22,
09/18/2026,09/18/2026,AUTOMATIC PAYMENT - THANK,,Payment,2020.17,
09/09/2026,09/10/2026,LIMELIGHT MAMMOTH FRON,Travel,Sale,-368.22,
09/08/2026,09/08/2026,STUBHUB CREDIT $300/YEAR,Fees & Adjustments,Adjustment,150.00,
09/08/2026,09/09/2026,STUBHUB INC,Entertainment,Sale,-574.39,
06/16/2026,06/16/2026,Offer:Chewy.com,Fees & Adjustments,Adjustment,10.00,
06/05/2026,06/07/2026,Uniqlo USA LLC,Shopping,Return,98.46,
06/01/2026,06/01/2026,ANNUAL MEMBERSHIP FEE,Fees & Adjustments,Fee,-795.00,
05/16/2026,05/17/2026,Uniqlo USA LLC,Shopping,Sale,-300.61,
05/13/2026,05/13/2026,REFUND IKEA 493172236,Home,Return,85.07,
05/12/2026,05/13/2026,IKEA 493172236,Home,Sale,-85.07,
05/12/2026,05/13/2026,IKEA 493180117,Home,Sale,-85.07,
12/31/2025,01/01/2026,QFC #5808,Groceries,Sale,-20.24,
`;

const WF = `"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"
"03/25/2026","SP BLIZZARD GEAR US INDIANAPOLIS IN","68.75",,"Posted"
"03/17/2026","BILL PAY PAYMENT","707.94",,"Posted"
"02/12/2026","SP BLIZZARD GEAR US GEAR.BLIZZARDIN","-90.75",,"Posted"
`;

const DISCOVER = `Trans. Date,Post Date,Description,Amount,Category
03/10/2026,03/10/2026,"TRADER JOE S #212 SAN JOSE CA",57.60,"Supermarkets"
03/14/2026,03/14/2026,"DIRECTPAY FULL BALANCE",-22.00,"Payments and Credits"
03/27/2026,03/27/2026,"AUTOMATIC STATEMENT CREDIT",-12.14,"Awards and Rebate Credits"
`;

const AMEX = `Date,Description,Card Member,Account #,Amount,Extended Details,Appears On Your Statement As,Category
09/22/2026,UBER ONE            help.uber.com       CA,A B,-1,96.00,"BSERKTXQ    8005928996
UBER ONE
help.uber.com",UBER ONE,Transportation-Taxis & Coach
09/22/2026,UBER EATS           help.uber.com       CA,A B,-1,96.00,"X
UBER EATS",UBER EATS,Restaurant-Restaurant
09/22/2026,Platinum Uber One Credit,A B,-1,-96.00,"UBER ONE
Platinum Uber One Credit",Platinum Uber One Credit,Transportation-Taxis & Coach
`;

function load(): BankRow[] {
  return [
    ...normalizeFile("Chase1714_Activity.CSV", CHASE),
    ...normalizeFile("WFCreditCard.csv", WF),
    ...normalizeFile("Discover-2026.csv", DISCOVER),
    ...normalizeFile("Amex-Plat.CSV", AMEX),
  ];
}

describe("normalize", () => {
  it("reads quoted multiline fields", () => {
    const rows = parseCsv(AMEX);
    expect(rows).toHaveLength(3);
    expect(rows[0]["Extended Details"].split("\n")[1]).toBe("UBER ONE");
  });

  it("signs every bank's spending as a positive sale", () => {
    const rows = load();
    const find = (m: RegExp) => rows.find((r) => m.test(r.merchant))!;
    expect(find(/^STUBHUB INC/)).toMatchObject({ kind: "sale", amount: 574.39, card: "Chase …1714" });
    expect(find(/GEAR.BLIZZARDIN/)).toMatchObject({ kind: "sale", amount: 90.75, card: "Wells Fargo" });
    expect(find(/TRADER JOE/)).toMatchObject({ kind: "sale", amount: 57.6, card: "Discover" });
    expect(find(/^UBER EATS/)).toMatchObject({ kind: "sale", amount: 96, card: "AMEX" });
  });

  it("classifies payments, fees, refunds, credits and cashback", () => {
    const kinds = (m: RegExp) => load().filter((r) => m.test(r.merchant)).map((r) => r.kind);
    expect(kinds(/PAYMENT|DIRECTPAY/)).toEqual(["payment", "payment", "payment"]);
    expect(kinds(/ANNUAL MEMBERSHIP FEE/)).toEqual(["fee"]);
    expect(kinds(/INDIANAPOLIS/)).toEqual(["refund"]);
    expect(kinds(/STUBHUB CREDIT|Platinum Uber One/)).toEqual(["credit", "credit"]);
    expect(kinds(/Offer:|STATEMENT CREDIT/)).toEqual(["cashback", "cashback"]);
  });

  it("drops transactions dated before the window, even if posted inside it", () => {
    expect(load().some((r) => r.merchant.startsWith("QFC"))).toBe(false);
  });
});

describe("refunds", () => {
  const net = (m: RegExp) =>
    applyRefunds(load())
      .ledger.filter((l) => m.test(l.row.merchant))
      .map((l) => l.net);

  it("drops a fully refunded purchase", () => {
    expect(net(/LIMELIGHT/)).toEqual([0]);
  });

  it("keeps a partially refunded purchase at its net", () => {
    expect(net(/Uniqlo/)).toEqual([202.15]);
    expect(net(/BLIZZARD/)).toEqual([22]);
  });

  it("uses the order number to pick which of two identical charges was refunded", () => {
    const ikea = applyRefunds(load()).ledger.filter((l) => /IKEA/.test(l.row.merchant));
    expect(ikea.map((l) => [l.row.merchant, l.net])).toEqual([
      ["IKEA 493172236", 0],
      ["IKEA 493180117", 85.07],
    ]);
  });

  it("offsets benefit credits against the purchase they were for", () => {
    expect(net(/^STUBHUB INC/)).toEqual([424.39]);
    // Uber One, not the same-priced Uber Eats order.
    expect(net(/^UBER ONE/)).toEqual([0]);
    expect(net(/^UBER EATS/)).toEqual([96]);
  });

  it("counts annual fees and ignores cashback", () => {
    const r = applyRefunds(load());
    expect(r.kept.some((l) => /ANNUAL MEMBERSHIP FEE/.test(l.row.merchant))).toBe(true);
    expect(r.ignored.map((x) => x.kind).sort()).toEqual(["cashback", "cashback", "payment", "payment", "payment"]);
  });

  it("strips card prefixes but not merchant names that begin like one", () => {
    expect(merchantKey("AplPay KURA REVOLVINBellevue WA")).toBe("KURA");
    expect(merchantKey("PAYPAL *EBAYINCSHIP")).toBe("EBAYINCSHIP");
    expect(merchantKey("SP BLIZZARD GEAR US")).toBe("BLIZZARD");
    expect(merchantKey("SPOTHERO 844-356-8054")).toBe("SPOTHERO");
    expect(merchantKey("THE HOME DEPOT #0630")).toBe("HOME");
  });
});

describe("reconcile against D1", () => {
  const d1 = (id: number, amount: number, merchant: string, date: string): D1Txn => ({
    id,
    amount,
    merchant,
    occurred_at: occurredAt(date),
    source: "email",
    category_id: null,
  });

  it("reads wrangler's --json envelope", () => {
    const rows = parseD1Export([{ results: [{ id: 1, amount: 5, merchant: "X", occurred_at: "2026-09-01T19:00:00Z" }], success: true }]);
    expect(rows).toEqual([
      { id: 1, amount: 5, merchant: "X", occurred_at: "2026-09-01T19:00:00Z", source: null, category_id: null },
    ]);
  });

  it("matches, deletes refunded, nets partials, inserts the rest", () => {
    const { ledger } = applyRefunds(load());
    const rec = reconcile(ledger, [
      d1(1, 368.22, "LIMELIGHT MAMMOTH FRON", "2026-09-09"), // refunded → delete
      d1(2, 574.39, "STUBHUB INC", "2026-09-08"), //           credited → net
      d1(3, 50.0, "TRADER JOE S", "2026-03-11"), //            pre-tip/corrected → keep
      d1(4, 12, "lunch", "2026-09-01"), //                     manual → d1-only
    ]);
    const by = (t: string) => rec.outcomes.filter((o) => o.type === t);
    expect(by("delete").map((o: any) => o.d1.id)).toEqual([1]);
    expect(by("update").map((o: any) => [o.d1.id, o.bank.net])).toEqual([[2, 424.39]]);
    expect(by("matched").map((o: any) => o.d1.id)).toEqual([3]);
    expect(by("d1-only").map((o: any) => o.d1.id)).toEqual([4]);
    expect(by("insert").some((o: any) => /TRADER JOE/.test(o.bank.row.merchant))).toBe(false);
    expect(by("insert").some((o: any) => /Uniqlo/.test(o.bank.row.merchant))).toBe(true);
  });

  it("doesn't pair same-amount charges at different merchants days apart", () => {
    const { ledger } = applyRefunds(load());
    const rec = reconcile(ledger, [d1(9, 57.6, "SOMEWHERE ELSE", "2026-03-13")]);
    expect(rec.counts["d1-only"]).toBe(1);
  });
});

describe("emitted SQL", () => {
  it("stamps imports at local noon, so they land on the statement date", () => {
    expect(occurredAt("2026-03-01")).toBe("2026-03-01T20:00:00.000Z"); // PST
    // DST starts overnight: 12h past local midnight is 1pm, still the same day.
    expect(localDayIso(new Date(occurredAt("2026-03-08")))).toBe("2026-03-08");
    expect(occurredAt("2026-07-01")).toBe("2026-07-01T19:00:00.000Z");
    expect(localDayIso(new Date(occurredAt("2026-12-31")))).toBe("2026-12-31");
  });

  it("is idempotent and keeps identical same-day charges distinct", async () => {
    const twice = CHASE + "09/06/2026,09/06/2026,Amazon Grocery,Groceries,Sale,-10.96,\n".repeat(2);
    const rec = reconcile(applyRefunds(normalizeFile("Chase4443.CSV", twice)).ledger, []);
    const a = await emitSql(rec);
    const b = await emitSql(rec);
    expect(a).toBe(b);
    const hashes = [...a.matchAll(/'import', '([0-9a-f]{64})'/g)].map((m) => m[1]);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(a.match(/Amazon Grocery/g)).toHaveLength(2);
    expect(a).not.toMatch(/LIMELIGHT/);
    expect(a).toMatch(/INSERT OR IGNORE INTO transactions .*VALUES \(202\.15, 'Uniqlo USA LLC'/);
  });

  it("escapes quotes in merchant names", async () => {
    const csv = CHASE.split("\n")[0] + "\n01/09/2026,01/11/2026,MCDONALD'S F13573,Food & Drink,Sale,-9.83,\n";
    const sql = await emitSql(reconcile(applyRefunds(normalizeFile("Chase7923.CSV", csv)).ledger, []));
    expect(sql).toContain("'MCDONALD''S F13573'");
  });
});

describe("reconcile: what D1 holds in other shapes", () => {
  const HEAD = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n";
  const chase = (lines: string[]) =>
    applyRefunds(normalizeFile("Chase1714.CSV", HEAD + lines.join("\n") + "\n")).ledger;
  const d1 = (id: number, amount: number, merchant: string, date: string, source = "email"): D1Txn => ({
    id,
    amount,
    merchant,
    occurred_at: occurredAt(date),
    source,
    category_id: null,
  });
  const types = (rec: ReturnType<typeof reconcile>) => rec.counts;

  it("sums per-restaurant DoorDash alerts into the one posted order", () => {
    const rec = reconcile(chase(["08/15/2026,08/15/2026,DOORDASH*08/14-3 ORDER,Food & Drink,Sale,-68.41,"]), [
      d1(52, 29.37, "DD *DOORDASH TARIMGA", "2026-08-14"),
      d1(53, 18.48, "DD *DOORDASH WESTCOA", "2026-08-14"),
      d1(54, 20.56, "DD *DOORDASH", "2026-08-14"),
    ]);
    expect(types(rec)).toMatchObject({ group: 1, insert: 0, "d1-only": 0 });
  });

  it("tolerates a split order whose total drifted by a tip", () => {
    const rec = reconcile(chase(["08/06/2026,08/06/2026,DOORDASH*08/05-2 ORDER,Food & Drink,Sale,-31.32,"]), [
      d1(33, 13.48, "DD *DOORDASH WESTCOA", "2026-08-05"),
      d1(34, 17.16, "DD *DOORDASH", "2026-08-05"),
    ]);
    const g = rec.outcomes.find((o) => o.type === "group");
    expect(g && g.type === "group" && g.note).toMatch(/tip or promo/);
  });

  it("recognizes a manual entry that rolls up several charges", () => {
    const rec = reconcile(
      chase([
        "09/26/2026,09/26/2026,UBER,Travel,Sale,-13.06,",
        "09/26/2026,09/26/2026,UBER,Travel,Sale,-15.08,",
        "09/26/2026,09/26/2026,UBER EATS,Food & Drink,Sale,-31.88,",
      ]),
      [d1(195, 28.14, "uber", "2026-09-25", "manual")],
    );
    expect(types(rec)).toMatchObject({ group: 1, insert: 1 });
  });

  it("keeps the user's half of a shared bill", () => {
    const rec = reconcile(chase(["08/30/2026,08/30/2026,FISHING BRIDGE,Food & Drink,Sale,-110.00,"]), [
      d1(99, 55, "FISHING BRIDGE", "2026-08-30"),
    ]);
    const m = rec.outcomes[0];
    expect(m.type).toBe("matched");
    expect(m.type === "matched" && m.note).toMatch(/D1 kept/);
  });

  it("turns a $0.01 hold into the posted charge, and drops holds that never posted", () => {
    const rec = reconcile(chase(["08/10/2026,08/11/2026,FD *CA DMV 640 *SVC,Bills,Sale,-12.94,"]), [
      d1(45, 0.01, "FD *CA DMV 640 *SVC", "2026-08-10"),
      d1(69, 0.01, "access our service hours", "2026-08-20"),
      d1(73, 0.01, "AIRBNB * HMZ2F5N9FN", "2026-08-21"),
      d1(188, 526.68, "AIRBNB * HMZ2F5N9FN", "2026-09-21"),
    ]);
    const by = (t: string) => rec.outcomes.filter((o) => o.type === t) as any[];
    expect(by("update").map((o) => [o.d1.id, o.amount])).toEqual([[45, 12.94]]);
    expect(by("delete").map((o) => [o.d1.id, o.reason])).toEqual([
      [69, "pre-auth hold that never posted"],
      [73, "pre-auth hold — real charge already recorded as #188"],
    ]);
    expect(by("d1-only").map((o) => o.d1.id)).toEqual([188]);
  });

  it("moves a correction that landed on the wrong row back", () => {
    const rec = reconcile(
      chase([
        "08/10/2026,08/11/2026,FD *CA DMV 640,Bills,Sale,-616.00,",
        "08/29/2026,08/30/2026,SLC PANDA EXPRESS 6231365,Food & Drink,Sale,-11.50,",
      ]),
      [d1(44, 0.01, "FD *CA DMV 640", "2026-08-10"), d1(91, 616, "SLC PANDA EXPRESS 62", "2026-08-29")],
    );
    const ups = rec.outcomes.filter((o) => o.type === "update") as any[];
    expect(ups.map((o) => [o.d1.id, o.amount]).sort()).toEqual([
      [44, 616],
      [91, 11.5],
    ]);
  });

  it("treats a name as a prefix of the posted one", () => {
    expect(merchantSimilarity("DD *DOORDASH", "DD *DOORDASHCOOKINGCOO")).toBe(1);
    expect(merchantSimilarity("CANYON GENERAL", "SNOWPINE LODGE")).toBe(0);
  });
});

describe("keyed changes", () => {
  it("keys every change and drops struck keys from the SQL", async () => {
    const { ledger } = applyRefunds(load());
    const rec = reconcile(ledger, [
      {
        id: 1,
        amount: 368.22,
        merchant: "LIMELIGHT MAMMOTH FRON",
        occurred_at: occurredAt("2026-09-09"),
        source: "email",
        category_id: 2,
      },
    ]);
    const changes = await planChanges(rec);
    expect(changes.find((c) => c.kind === "delete")).toMatchObject({ key: "D-0001", d1Id: 1 });
    const firstInsert = changes.find((c) => c.kind === "insert")!;
    expect(firstInsert.key).toBe("I-0001");

    const all = renderSql(changes);
    expect(all).toContain("DELETE FROM transactions WHERE id = 1; -- D-0001");
    const skipped = renderSql(changes, parseSkip("d-0001, I-0001"));
    expect(skipped).not.toContain("-- D-0001");
    expect(skipped).not.toContain(`-- ${firstInsert.key}\n`);
    expect(skipped).toContain("-- Skipped: D-0001, I-0001");
    // Keys don't shift when others are struck.
    expect(skipped).toContain("-- I-0002");
  });
});

describe("proposed-changes.csv", () => {
  it("has one row per change and round-trips awkward merchant names", async () => {
    const HEAD = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n";
    const csv =
      HEAD +
      '01/09/2026,01/11/2026,"MCDONALD\'S, ""THE"" ONE",Food & Drink,Sale,-9.83,\n' +
      "09/09/2026,09/10/2026,LIMELIGHT MAMMOTH FRON,Travel,Sale,-368.22,\n" +
      "09/22/2026,09/22/2026,LIMELIGHT MAMMOTH FRON,Travel,Return,368.22,\n";
    const rec = reconcile(applyRefunds(normalizeFile("Chase1714.CSV", csv)).ledger, [
      {
        id: 7,
        amount: 368.22,
        merchant: "LIMELIGHT MAMMOTH FR",
        occurred_at: occurredAt("2026-09-09"),
        source: "email",
        category_id: null,
      },
    ]);
    const changes = await planChanges(rec);
    const rows = parseCsv(renderChangesCsv(changes, parseSkip("D-0001"), "2026-07-20"));

    expect(rows.map((r) => r.key)).toEqual(changes.map((c) => c.key));
    expect(rows[0]).toMatchObject({ key: "D-0001", action: "delete", d1_id: "7", amount: "368.22", change_to_total: "-368.22", skipped: "yes" });
    expect(rows[1]).toMatchObject({
      key: "I-0001",
      action: "insert",
      merchant: 'MCDONALD\'S, "THE" ONE',
      amount: "9.83",
      window: "before-bot",
      skipped: "",
    });
    expect(changes.map(changeToTotal)).toEqual([-368.22, 9.83]);
  });
});
