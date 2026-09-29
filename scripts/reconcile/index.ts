// CLI: bank CSV exports + D1 export → out/reconcile.sql + out/proposed-changes.{md,csv}
//
//   npm run reconcile -- --zip ~/Downloads/2026Finance.zip --d1 d1-transactions.json
//   npm run reconcile -- --dir ./2026Finance                 (no --d1: plan inserts only)
//   … --skip I-0012,D-0003                                   (strike changes after review)
//
// Nothing here touches D1. Review the report, then apply the SQL yourself.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeFile, type BankRow } from "./normalize";
import { applyRefunds } from "./refunds";
import { parseD1Export, reconcile } from "./diff";
import { parseSkip, planChanges, renderSql } from "./emit-sql";
import { localDayIso } from "../../src/core/period";
import { renderChangesCsv, renderReport } from "./report";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function csvFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name.startsWith("__MACOSX") || name.startsWith("._")) return [];
    if (statSync(path).isDirectory()) return csvFiles(path);
    return /\.csv$/i.test(name) ? [path] : [];
  });
}

async function main(): Promise<void> {
  const zip = arg("zip");
  let dir = arg("dir");
  const d1Path = arg("d1");
  const since = arg("since") ?? "2026-01-01";
  const out = arg("out") ?? "out";
  const skip = parseSkip(arg("skip"));
  if (!zip && !dir) {
    console.error("usage: npm run reconcile -- (--zip <file> | --dir <folder>) [--d1 <export.json>] [--since YYYY-MM-DD] [--skip KEYS]");
    process.exit(2);
  }
  if (zip) {
    dir = mkdtempSync(join(tmpdir(), "reconcile-"));
    execFileSync("unzip", ["-q", "-o", zip, "-d", dir]);
  }

  const rows: BankRow[] = csvFiles(dir!).flatMap((f) =>
    normalizeFile(f, readFileSync(f, "utf8"), since),
  );
  const refunds = applyRefunds(rows);
  const d1 = d1Path ? parseD1Export(JSON.parse(readFileSync(d1Path, "utf8"))) : [];
  const rec = reconcile(refunds.ledger, d1);

  const changes = await planChanges(rec);
  const unknown = [...skip].filter((k) => !changes.some((c) => c.key === k));
  if (unknown.length) throw new Error(`--skip names keys that don't exist: ${unknown.join(", ")}`);
  const botStart = d1.length ? d1.map((d) => localDayIso(new Date(d.occurred_at))).sort()[0] : null;

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "reconcile.sql"), renderSql(changes, skip));
  writeFileSync(join(out, "proposed-changes.md"), renderReport({ rows, refunds, rec, changes, skip, botStart }));
  writeFileSync(join(out, "proposed-changes.csv"), renderChangesCsv(changes, skip, botStart));
  const live = changes.filter((c) => !skip.has(c.key));
  const n = (k: string) => live.filter((c) => c.kind === k).length;
  console.log(
    `${rows.length} statement rows, ${d1.length} D1 rows → ` +
      `delete ${n("delete")}, update ${n("update")}, insert ${n("insert")}` +
      (skip.size ? ` (${skip.size} skipped)` : "") +
      `. Wrote ${out}/reconcile.sql and ${out}/proposed-changes.{md,csv}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
