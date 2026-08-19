import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { explainOne, orderedParams, type PlanResult } from "./harness/explain.ts";
import { parseTestBlock } from "./harness/parse.ts";

function leq(actual: number, limit: number, label: string, detail = ""): void {
  assert.ok(actual <= limit, `${label} ${actual.toFixed(2)} exceeds limit ${limit}${detail}`);
}

// Every queries/*.sql file becomes a node:test, so coverage is intrinsic: a file
// with no valid @test block fails as that file's test.

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = resolve(HERE, "..", "queries");

const DEFAULT_COST = 100;
const DEFAULT_ROW_COUNT_RATIO = 10;

const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5433),
  user: process.env.PGUSER ?? "harness",
  password: process.env.PGPASSWORD ?? "harness",
  database: process.env.PGDATABASE ?? "parkdb",
  max: 4,
});

const skipSummary: Array<{ file: string; reason: string }> = [];

function discover(): string[] {
  return readdirSync(QUERIES_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

const files = discover();

describe("query-cost harness", () => {
  before(async () => {
    const c = await pool.connect();
    c.release();
  });

  after(async () => {
    await pool.end();
    if (skipSummary.length) {
      console.log(`\n=== Skipped queries (${skipSummary.length}) ===`);
      for (const s of skipSummary) console.log(`  - ${s.file}: ${s.reason}`);
    }
  });

  if (files.length === 0) {
    test("discovery", () => {
      throw new Error(`no .sql files found in ${QUERIES_DIR}`);
    });
    return;
  }

  for (const file of files) {
    test(file, async (t) => {
      const sql = readFileSync(join(QUERIES_DIR, file), "utf8");
      const parsed = parseTestBlock(sql);

      if (parsed.kind === "skip") {
        skipSummary.push({ file, reason: parsed.reason });
        t.skip(parsed.reason);
        return;
      }

      for (let i = 0; i < parsed.cases.length; i++) {
        const c = parsed.cases[i];
        await t.test(`param ${i}`, async (st) => {
          const client = await pool.connect();
          let plan: PlanResult;
          try {
            plan = await explainOne(client, sql, orderedParams(c.values));
          } finally {
            client.release();
          }

          const costLimit = c.thresholds.cost ?? DEFAULT_COST;
          const ratioLimit = c.thresholds.rowCountRatio ?? DEFAULT_ROW_COUNT_RATIO;

          if (plan.totalCost > costLimit || plan.rowCountRatio > ratioLimit) {
            st.diagnostic(`cost=${plan.totalCost.toFixed(1)} (limit ${costLimit}) | ` + `rowCountRatio=${plan.rowCountRatio.toFixed(2)} (limit ${ratioLimit}) | ` + `planRows=${plan.planRows} actualRows=${plan.actualRows} | ` + `actualTotalTime=${plan.actualTotalTimeMs.toFixed(1)}ms [not gated]`);
          }

          leq(plan.totalCost, costLimit, "cost");
          leq(plan.rowCountRatio, ratioLimit, "rowCountRatio", ` (planRows=${plan.planRows}, actualRows=${plan.actualRows})`);
        });
      }
    });
  }
});
