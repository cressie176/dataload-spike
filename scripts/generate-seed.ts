/**
 * Deterministic seed generator. Emits `seed.sql` as `COPY ... FROM stdin` blocks
 * (not per-row INSERTs) so millions of reservation rows load fast.
 *
 * Deterministic by design: a fixed-seed RNG means the same inputs always produce
 * byte-identical output, so the seed's content hash is stable and can tag the image.
 * The seed is a regenerable single-state SNAPSHOT — never an accumulating delta.
 *
 * Prod-shape is the point: the seasonal booking curve (near-full Jul/Aug, ramping
 * to summer, closed Dec/Jan) gives date-range predicates very different selectivity
 * by month, and the skewed grade distribution gives the grade index a realistic
 * n_distinct/MCV shape. Those distributions are what drive planner choices.
 *
 * Two outputs, from ONE deterministic pass (so both describe identical data):
 *   - seed.sql              — all tables, one file, for the serial COPY baseline.
 *   - chunks/park-NNN.sql   — one file per park containing that park's ENTIRE
 *                             subtree (park + its pitches + vans + reservations)
 *                             as COPY blocks in FK order. Park subtrees never
 *                             reference each other, so the chunks are independent
 *                             and can be COPYed concurrently with no join-up pass.
 *   - chunks/_finalize.sql  — the setval() sequence resets, run ONCE after all
 *                             chunks load (sequences are global, not per-park).
 */

import { once } from "node:events";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Parameters (env-overridable; defaults produce ~2-3M reservations) --------

const PARK_COUNT = Number(process.env.SEED_PARKS ?? 40);
const PITCHES_MIN = Number(process.env.SEED_PITCHES_MIN ?? 500);
const PITCHES_MAX = Number(process.env.SEED_PITCHES_MAX ?? 2000);
const SEASONS = (process.env.SEED_SEASONS ?? "2023,2024,2025").split(",").map((y) => Number(y.trim()));
const RNG_SEED = Number(process.env.SEED_RNG ?? 0x5eed);

const MODELS = ["Alpine", "Biscay", "Coastline", "Dorset", "Elgin", "Fairway", "Grasmere", "Havana", "Ionian", "Jasmine"];

// Grade distribution — deliberately skewed so van_grade has a realistic MCV shape
// (savers/bronze common, platinum rare). Cumulative weights.
const GRADE_WEIGHTS: Array<[string, number]> = [
  ["saver", 0.35],
  ["bronze", 0.3],
  ["silver", 0.2],
  ["gold", 0.12],
  ["platinum", 0.03],
];

// Monthly booking weight (1-indexed month → probability a slot is taken).
// Closed Dec/Jan (0); near-full Jul/Aug; ramps up to and down from summer.
const MONTH_WEIGHT: Record<number, number> = {
  1: 0.0,
  2: 0.18,
  3: 0.28,
  4: 0.42,
  5: 0.58,
  6: 0.78,
  7: 0.95,
  8: 0.97,
  9: 0.68,
  10: 0.42,
  11: 0.22,
  12: 0.0,
};

// Stay lengths in nights, weighted toward a week. Cumulative.
const STAY_LENGTHS: Array<[number, number]> = [
  [3, 0.2],
  [4, 0.15],
  [7, 0.45],
  [10, 0.12],
  [14, 0.08],
];

// ---- Seeded RNG (mulberry32) --------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Date helpers (UTC, no time component) ------------------------------------

const DAY_MS = 86_400_000;
const fmtDate = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);

// ---- Buffered append-only writer ----------------------------------------------

class BufWriter {
  private stream: ReturnType<typeof createWriteStream>;
  private buf: string[] = [];

  constructor(path: string) {
    this.stream = createWriteStream(path);
  }

  line(text: string) {
    this.buf.push(text.endsWith("\n") ? text : `${text}\n`);
  }

  async maybeFlush() {
    if (this.buf.length >= 8192) await this.flush();
  }

  private async flush() {
    if (!this.buf.length) return;
    const chunk = this.buf.join("");
    this.buf = [];
    if (!this.stream.write(chunk)) await once(this.stream, "drain");
  }

  async close() {
    await this.flush();
    this.stream.end();
    await once(this.stream, "finish");
  }
}

// ---- Paths --------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(HERE, "..", "seed.sql");
const CHUNK_DIR = resolve(HERE, "..", "chunks");

// A COPY writer that mirrors every row into BOTH the monolithic seed.sql and the
// current park's chunk file, so the two outputs are byte-consistent by construction.
class FanoutCopy {
  private targets: BufWriter[] = [];

  set(...writers: BufWriter[]) {
    this.targets = writers;
  }

  header(sql: string) {
    for (const w of this.targets) w.line(sql);
  }

  async row(cols: (string | number)[]) {
    const line = cols.join("\t");
    for (const w of this.targets) w.line(line);
    for (const w of this.targets) await w.maybeFlush();
  }

  endCopy() {
    for (const w of this.targets) {
      w.line("\\.");
      w.line("");
    }
  }
}

// ---- Generation ---------------------------------------------------------------

async function main() {
  rmSync(CHUNK_DIR, { recursive: true, force: true });
  mkdirSync(CHUNK_DIR, { recursive: true });

  const seed = new BufWriter(SEED_PATH);
  const fan = new FanoutCopy();

  const rng = mulberry32(RNG_SEED);
  const randInt = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
  const weightedPick = <T,>(table: Array<[T, number]>): T => {
    const r = rng();
    let acc = 0;
    for (const [value, weight] of table) {
      acc += weight;
      if (r < acc) return value;
    }
    return table[table.length - 1][0];
  };

  seed.line("-- Generated by scripts/generate-seed.ts — do not edit by hand.");
  seed.line(`-- parks=${PARK_COUNT} pitches=${PITCHES_MIN}-${PITCHES_MAX} seasons=${SEASONS.join("/")} rngSeed=${RNG_SEED}`);
  seed.line("SET client_min_messages = notice;");
  seed.line("");
  seed.line("DO $$ BEGIN RAISE NOTICE '[seed %] start', clock_timestamp(); END $$;");

  let pitchId = 0;
  let vanId = 0;
  let reservationId = 0;

  // One deterministic pass over parks. Because the RNG is a single stream consumed
  // in a fixed order (park → its pitches/vans → its reservations), the output is
  // byte-stable AND each park's rows are contiguous — which is exactly what lets us
  // tee them into a per-park chunk without changing the monolithic seed.sql content.
  for (let p = 1; p <= PARK_COUNT; p++) {
    const chunkPath = resolve(CHUNK_DIR, `park-${String(p).padStart(3, "0")}.sql`);
    const chunk = new BufWriter(chunkPath);
    chunk.line(`-- Park ${p} subtree — independent COPY chunk (park→pitch→van→reservation).`);
    chunk.line("SET client_min_messages = warning;");
    chunk.line("");

    // park (single row) → both files
    fan.set(seed, chunk);
    fan.header("COPY park (id, name) FROM stdin;");
    await fan.row([p, `Park ${p}`]);
    fan.endCopy();

    // Decide this park's pitch count, then generate its pitch+van rows together
    // (1:1). We buffer the van rows so each table gets its own COPY block within
    // the chunk (COPY is per-table), while preserving generation/RNG order.
    const pitches = randInt(PITCHES_MIN, PITCHES_MAX);
    const parkPitchRows: (string | number)[][] = [];
    const parkVanRows: (string | number)[][] = [];
    for (let i = 0; i < pitches; i++) {
      pitchId++;
      const lat = (50 + rng() * 8).toFixed(6);
      const lng = (-5 + rng() * 7).toFixed(6);
      parkPitchRows.push([pitchId, p, lat, lng]);

      vanId++;
      parkVanRows.push([vanId, pitchId, MODELS[randInt(0, MODELS.length - 1)], weightedPick(GRADE_WEIGHTS)]);
    }

    fan.header("COPY pitch (id, park_id, lat, lng) FROM stdin;");
    for (const row of parkPitchRows) await fan.row(row);
    fan.endCopy();

    fan.header("COPY van (id, pitch_id, model, grade) FROM stdin;");
    for (const row of parkVanRows) await fan.row(row);
    fan.endCopy();

    // reservation — the bulk. Walk each van in this park across each season's open
    // window, booking stays with month-weighted probability. Same algorithm as the
    // original monolithic generator; only the emission is teed per-park.
    fan.header("COPY reservation (id, van_id, start_date, end_date) FROM stdin;");
    for (const vanRow of parkVanRows) {
      const v = vanRow[0] as number;
      for (const year of SEASONS) {
        let cursor = new Date(Date.UTC(year, 1, 1)); // Feb 1
        const seasonEnd = new Date(Date.UTC(year, 10, 30)); // Nov 30
        while (cursor < seasonEnd) {
          const month = cursor.getUTCMonth() + 1;
          const weight = MONTH_WEIGHT[month] ?? 0;
          if (weight > 0 && rng() < weight) {
            const nights = weightedPick(STAY_LENGTHS);
            const end = addDays(cursor, nights);
            reservationId++;
            await fan.row([reservationId, v, fmtDate(cursor), fmtDate(end)]);
            cursor = end; // checkout day is the next booking's earliest start
          } else {
            cursor = addDays(cursor, randInt(2, 6)); // vacancy gap
          }
        }
      }
    }
    fan.endCopy();

    await chunk.close();
  }

  seed.line("DO $$ BEGIN RAISE NOTICE '[seed %] all COPY blocks done', clock_timestamp(); END $$;");

  // Sequence resets are GLOBAL, not per-park — emit them into seed.sql (serial path)
  // and into a standalone _finalize.sql (parallel path runs it once after all chunks).
  const finalize = new BufWriter(resolve(CHUNK_DIR, "_finalize.sql"));
  const setvals = [
    `SELECT setval('park_id_seq', ${PARK_COUNT});`,
    `SELECT setval('pitch_id_seq', ${pitchId});`,
    `SELECT setval('van_id_seq', ${vanId});`,
    `SELECT setval('reservation_id_seq', ${reservationId});`,
  ];
  for (const s of setvals) {
    seed.line(s);
    finalize.line(s);
  }

  await finalize.close();
  await seed.close();

  console.error(`seed.sql + ${PARK_COUNT} chunks written: ${PARK_COUNT} parks, ${pitchId} pitches, ${vanId} vans, ${reservationId} reservations`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
