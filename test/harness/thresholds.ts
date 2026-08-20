import { createHash } from "node:crypto";

export interface Gate {
  cost: number;
  rowCountRatio: number;
}

export const DEFAULT_GATE: Gate = { cost: 100, rowCountRatio: 10 };

// Fingerprint = sha256 of the SQL Drizzle generated, first 12 chars. A given
// call site produces stable SQL, so the fingerprint is stable — but it is
// opaque, which is the price of catching queries that were never hand-written.
// Run the suite once with DRIZZLE_GATE_LOG=1 to print (fingerprint, sql) pairs,
// then pin overrides here for anything that legitimately needs a wider budget.
const OVERRIDES: Record<string, Partial<Gate>> = {
  // "3f9a1c0b2d4e": { cost: 500 }, // vans-by-park listing, big result set
};

export function fingerprint(sql: string): string {
  const normalized = sql.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function gateFor(sql: string): Gate {
  return { ...DEFAULT_GATE, ...OVERRIDES[fingerprint(sql)] };
}
