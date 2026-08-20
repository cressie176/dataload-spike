import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { van } from "../src/schema/index.ts";
import { type Breach, makeGatedDb } from "./harness/proxy-gate.ts";

const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5433),
  user: process.env.PGUSER ?? "harness",
  password: process.env.PGPASSWORD ?? "harness",
  database: process.env.PGDATABASE ?? "parkdb",
  max: 4,
});

const { db, breaches } = makeGatedDb(pool);

function breachFor(sql: RegExp): Breach | undefined {
  return breaches.find((b) => sql.test(b.sql));
}

describe("drizzle proxy gate", () => {
  before(async () => {
    const c = await pool.connect();
    c.release();
  });
  after(async () => pool.end());

  // A cheap indexed lookup Drizzle generates from a .where() — no .sql file
  // exists for it, yet the gate sees and passes it.
  test("indexed retrieval passes", async () => {
    await db.select().from(van).where(eq(van.grade, "platinum")).limit(50);
    assert.equal(breachFor(/from "van".*"grade"/s), undefined);
  });

  // model has no index, so filtering on it is a full scan of van — the gate
  // should flag the query even though no .sql file describes it.
  test("unindexed filter is flagged", async () => {
    await db.select().from(van).where(eq(van.model, "Alpine"));
    const b = breachFor(/from "van".*"model"/s);
    assert.ok(b, "expected a breach for the unindexed model scan");
    assert.ok(b.cost > b.costLimit || b.rowCountRatio > b.ratioLimit);
  });
});
