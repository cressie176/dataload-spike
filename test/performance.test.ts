import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Pool } from "pg";
import type { Db } from "../src/persistence.ts";
import * as facade from "../src/persistence.ts";
import { makeGatedDb, planOf } from "./harness/gate.ts";

/**
 * The persistence facade is the coverage surface: every exported query function
 * must appear in GATES below with either a gate (cost/rowCountRatio, invoked
 * with representative args) or a skip reason. A function present in the facade
 * but absent from GATES fails the coverage test — it can't be silently untested.
 *
 * Gates live here, in the test, so the facade stays free of test concerns.
 */

const DEFAULT_COST = 100;
const DEFAULT_ROW_COUNT_RATIO = 10;

interface Gate {
  cost?: number;
  rowCountRatio?: number;
}

type Case = { skip: string } | { run: (db: Db) => Promise<unknown>; gate?: Gate };

const GATES: Record<keyof typeof facade, Case[]> = {
  // Common grade (saver ~35%) vs rare (platinum ~3%): skew may flip the plan
  // between seq scan and index scan, so exercise both.
  vansByGrade: [
    { run: (db) => facade.vansByGrade(db, "saver"), gate: { cost: 2000 } },
    { run: (db) => facade.vansByGrade(db, "platinum"), gate: { cost: 2000 } },
  ],

  // Same park/window, July (peak) vs November (shoulder): different selectivity
  // by month is the point. November's EXISTS anti-join is inherently hard to
  // estimate under seasonal skew (planRows ~1-3, actualRows ~536, and it swings
  // build-to-build as ANALYZE samples randomly), so its ratio override sits
  // above the worst case rather than at a tight, flaky value.
  availabilityByDateRange: [
    { run: (db) => facade.availabilityByDateRange(db, 12, "2025-07-05", "2025-07-12"), gate: { cost: 20000 } },
    { run: (db) => facade.availabilityByDateRange(db, 12, "2025-11-05", "2025-11-12"), gate: { cost: 20000, rowCountRatio: 1000 } },
  ],

  // Deliberately expensive: full scan + hash-aggregate of every reservation,
  // no selective predicate. Left on the default cost gate so it FAILS —
  // demonstrates the harness catching a query that's fine functionally but
  // catastrophic under email-spike load.
  busiestModelsAllParks: [{ run: (db) => facade.busiestModelsAllParks(db) }],

  // Full 4-table join; healthy multi-joins mis-estimate up the tree, so the
  // ratio is loosened.
  gradeOccupancyByPark: [{ run: (db) => facade.gradeOccupancyByPark(db, 3, "2025-06-01", "2025-09-01"), gate: { cost: 40000, rowCountRatio: 25 } }],

  parkBookings: [{ run: (db) => facade.parkBookings(db, 7, "2025-02-01", "2025-11-30"), gate: { cost: 30000 } }],

  vacuumReservation: [{ skip: "VACUUM cannot run inside a transaction block, so it can't be EXPLAIN ANALYZE'd" }],
};

const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5433),
  user: process.env.PGUSER ?? "harness",
  password: process.env.PGPASSWORD ?? "harness",
  database: process.env.PGDATABASE ?? "parkdb",
  max: 4,
});

const db = makeGatedDb(pool);

function leq(actual: number, limit: number, label: string, detail = ""): void {
  assert.ok(actual <= limit, `${label} ${actual.toFixed(2)} exceeds limit ${limit}${detail}`);
}

describe("query-cost harness", () => {
  before(async () => {
    const c = await pool.connect();
    c.release();
  });
  after(async () => pool.end());

  test("every facade function is gated or skipped", () => {
    const missing = Object.keys(facade).filter((name) => !(name in GATES));
    assert.deepEqual(missing, [], `facade functions missing a GATES entry (untested): ${missing.join(", ")}`);
  });

  for (const [name, cases] of Object.entries(GATES)) {
    test(name, async (t) => {
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        if ("skip" in c) {
          t.skip(c.skip);
          continue;
        }
        await t.test(`case ${i}`, async (st) => {
          const plan = await planOf(c.run(db));
          const costLimit = c.gate?.cost ?? DEFAULT_COST;
          const ratioLimit = c.gate?.rowCountRatio ?? DEFAULT_ROW_COUNT_RATIO;

          if (plan.totalCost > costLimit || plan.rowCountRatio > ratioLimit) {
            st.diagnostic(`cost=${plan.totalCost.toFixed(1)} (limit ${costLimit}) | rowCountRatio=${plan.rowCountRatio.toFixed(2)} (limit ${ratioLimit}) | planRows=${plan.planRows} actualRows=${plan.actualRows} | actualTotalTime=${plan.actualTotalTimeMs.toFixed(1)}ms [not gated]`);
          }

          leq(plan.totalCost, costLimit, "cost");
          leq(plan.rowCountRatio, ratioLimit, "rowCountRatio", ` (planRows=${plan.planRows}, actualRows=${plan.actualRows})`);
        });
      }
    });
  }
});
