import { parse as parseYaml } from "yaml";

/**
 * Strict parser for the inline `@test` block. Design (see README): the block is
 * a single `/* @test ... *\/` comment holding YAML. A file must resolve to
 * exactly one of: a set of param cases, or a skip-with-reason. Anything else
 * (no block, malformed YAML, neither key, empty skip) is a loud failure — never
 * a silent pass and never confused with "untested".
 */

export interface Thresholds {
  cost?: number;
  rowCountRatio?: number;
}

export interface ParamCase {
  /** Ordered values → $1, $2, … by declaration order. Keys are for readability. */
  values: Record<string, unknown>;
  thresholds: Thresholds;
}

export type ParsedTest = { kind: "params"; cases: ParamCase[] } | { kind: "skip"; reason: string };

export class TestBlockError extends Error {}

// Matches the first /* @test ... */ block. `[\s\S]` so it spans newlines;
// non-greedy so it stops at the first closing */.
const BLOCK_RE = /\/\*\s*@test\b([\s\S]*?)\*\//;

export function parseTestBlock(sql: string): ParsedTest {
  const m = BLOCK_RE.exec(sql);
  if (!m) {
    throw new TestBlockError("no `@test` block found — every query file must declare one (untested)");
  }

  const body = m[1];
  let doc: unknown;
  try {
    doc = parseYaml(body);
  } catch (err) {
    throw new TestBlockError(`@test block is not valid YAML: ${(err as Error).message}`);
  }

  if (doc === null || typeof doc !== "object") {
    throw new TestBlockError("@test block is empty or not a mapping — expected `params:` or `skip:`");
  }

  const obj = doc as Record<string, unknown>;
  const hasParams = "params" in obj;
  const hasSkip = "skip" in obj;

  if (hasParams && hasSkip) {
    throw new TestBlockError("@test block has both `params` and `skip` — declare exactly one");
  }

  if (hasSkip) {
    const reason = obj.skip;
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new TestBlockError("`skip` requires a non-empty reason string (skips must stay auditable)");
    }
    return { kind: "skip", reason: reason.trim() };
  }

  if (!hasParams) {
    throw new TestBlockError("@test block has neither `params` nor `skip` — one is required");
  }

  const rawCases = obj.params;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new TestBlockError("`params` must be a non-empty list of param sets");
  }

  const cases: ParamCase[] = rawCases.map((raw, i) => {
    if (raw === null || typeof raw !== "object") {
      throw new TestBlockError(`params[${i}] must be a mapping`);
    }
    const c = raw as Record<string, unknown>;

    if (!("values" in c)) {
      throw new TestBlockError(`params[${i}] is missing \`values\``);
    }
    const values = c.values;
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      throw new TestBlockError(`params[${i}].values must be a mapping (may be empty {})`);
    }

    const thresholds = parseThresholds(c.thresholds, i);
    return { values: values as Record<string, unknown>, thresholds };
  });

  return { kind: "params", cases };
}

function parseThresholds(raw: unknown, i: number): Thresholds {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TestBlockError(`params[${i}].thresholds must be a mapping`);
  }
  const t = raw as Record<string, unknown>;
  const out: Thresholds = {};
  for (const key of ["cost", "rowCountRatio"] as const) {
    if (key in t) {
      const v = t[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        throw new TestBlockError(`params[${i}].thresholds.${key} must be a positive number`);
      }
      out[key] = v;
    }
  }
  return out;
}
