import { drizzle, type PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import type { Pool } from "pg";
import { type PlanResult, planFromExplainRow } from "./explain.ts";

/**
 * A Drizzle driver that EXPLAINs every SELECT it generates and records the plan,
 * then delegates to node-pg. Because it sits under the persistence facade, the
 * plan of any facade function is captured just by calling it — no hand-written
 * .sql, no separate catalog of queries. The facade IS the coverage surface.
 *
 * EXPLAIN ANALYZE executes the query, so this only gates reads ('all', and
 * 'execute' on a leading SELECT); writes/DDL pass straight through un-analysed.
 */

const captured: PlanResult[] = [];

function isRead(sql: string, method: string): boolean {
  if (method === "all") return true;
  return /^\s*(select|with|table)\b/i.test(sql);
}

export function makeGatedDb(pool: Pool): PgRemoteDatabase {
  return drizzle(async (sql, params, method) => {
    if (isRead(sql, method)) {
      const explained = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) ${sql}`, params);
      captured.push(planFromExplainRow(explained.rows[0]["QUERY PLAN"]));
    }

    // pg-proxy maps 'all' results positionally, so the real read must return
    // row arrays; 'execute' rows pass through untouched.
    const res = method === "all" ? await pool.query({ text: sql, values: params, rowMode: "array" }) : await pool.query(sql, params);
    return { rows: res.rows };
  });
}

/** Run a facade call and return the plan the gate captured for its query. */
export async function planOf(call: Promise<unknown>): Promise<PlanResult> {
  const before = captured.length;
  await call;
  const plans = captured.slice(before);
  if (plans.length !== 1) {
    throw new Error(`expected exactly one gated query, captured ${plans.length}`);
  }
  return plans[0];
}
