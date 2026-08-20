import { drizzle, type PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import type { Pool } from "pg";
import { planFromExplainRow } from "./explain.ts";
import { fingerprint, gateFor } from "./thresholds.ts";

/**
 * A Drizzle driver that EXPLAINs every SELECT it generates before running it,
 * failing the process if the plan breaches its gate. Unlike the file harness
 * this catches queries that were never hand-written as .sql — ORM retrievals
 * with a where clause, joins Drizzle builds from relations, etc.
 *
 * Test-mode only: every gated query hits the DB twice (EXPLAIN + real), so this
 * is never a production driver. Writes are not ANALYZE-d (that would execute
 * them) — only read paths ('all', and 'execute' on a leading SELECT) are gated.
 */

export interface Breach {
  fingerprint: string;
  sql: string;
  cost: number;
  costLimit: number;
  rowCountRatio: number;
  ratioLimit: number;
}

const LOG = process.env.DRIZZLE_GATE_LOG === "1";

function isRead(sql: string, method: string): boolean {
  if (method === "all") return true;
  return /^\s*(select|with|table)\b/i.test(sql);
}

export function makeGatedDb(pool: Pool): { db: PgRemoteDatabase; breaches: Breach[] } {
  const breaches: Breach[] = [];

  const db = drizzle(async (sql, params, method) => {
    if (isRead(sql, method)) {
      const fp = fingerprint(sql);
      const explained = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) ${sql}`, params);
      const plan = planFromExplainRow(explained.rows[0]["QUERY PLAN"]);
      const gate = gateFor(sql);

      if (LOG) console.log(`[gate] ${fp} cost=${plan.totalCost.toFixed(1)} ratio=${plan.rowCountRatio.toFixed(2)} :: ${sql}`);

      if (plan.totalCost > gate.cost || plan.rowCountRatio > gate.rowCountRatio) {
        breaches.push({ fingerprint: fp, sql, cost: plan.totalCost, costLimit: gate.cost, rowCountRatio: plan.rowCountRatio, ratioLimit: gate.rowCountRatio });
      }
    }

    // pg-proxy maps 'all' results positionally, so the real read must return
    // row arrays; 'execute' rows pass through untouched.
    const res = method === "all" ? await pool.query({ text: sql, values: params, rowMode: "array" }) : await pool.query(sql, params);
    return { rows: res.rows };
  });

  return { db, breaches };
}
