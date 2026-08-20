import type { Pool, PoolClient } from "pg";

/**
 * Runs one param set under `BEGIN; EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) <q>; ROLLBACK;`
 * and extracts the three signals the harness reports on. Uniform wrapping (README):
 * EXPLAIN ANALYZE *executes* the query, so anything mutating would contaminate the
 * distribution later queries' plans depend on — ROLLBACK keeps the DB pristine.
 */

export interface PlanResult {
  totalCost: number;
  planRows: number;
  actualRows: number;
  actualTotalTimeMs: number;
  /** max(actual,plan)/min(actual,plan) at the top node. */
  rowCountRatio: number;
}

interface PlanNode {
  "Total Cost": number;
  "Plan Rows": number;
  "Actual Rows": number;
  "Actual Total Time": number;
}

/** Ordered param values → positional $1..$n by declaration order. */
export function orderedParams(values: Record<string, unknown>): unknown[] {
  return Object.values(values);
}

export function planFromExplainRow(queryPlan: { Plan: PlanNode }[]): PlanResult {
  const top = queryPlan[0].Plan;
  const totalCost = top["Total Cost"];
  const planRows = top["Plan Rows"];
  const actualRows = top["Actual Rows"];
  const actualTotalTimeMs = top["Actual Total Time"];

  // Guard the 0-row case: a ratio of x/0 is meaningless. Treat "both 0" as a
  // perfect estimate (ratio 1); if only one side is 0, clamp the other to 1.
  const hi = Math.max(actualRows, planRows);
  const lo = Math.min(actualRows, planRows);
  const rowCountRatio = hi === 0 ? 1 : hi / Math.max(lo, 1);

  return { totalCost, planRows, actualRows, actualTotalTimeMs, rowCountRatio };
}

export async function explainOne(client: PoolClient | Pool, sql: string, params: unknown[]): Promise<PlanResult> {
  await client.query("BEGIN");
  try {
    const res = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) ${sql}`, params);
    return planFromExplainRow(res.rows[0]["QUERY PLAN"]);
  } finally {
    await client.query("ROLLBACK");
  }
}
