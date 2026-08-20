# Implementation Plan — Query-Cost Test Harness POC

> Build sheet for the POC. The **design rationale** lives in [`README.md`](./README.md) (the shareable design doc, source of truth). This document is the "how we'll build it" companion.

## Context

The example workload is a holiday-park booking system. Under a traffic spike (e.g. after a marketing email) it can see thousands of concurrent users at once; at that concurrency a single bad query plan on a hot table is catastrophic, while query *planning* overhead is negligible. This harness runs `EXPLAIN ANALYZE` over every SQL query in the codebase and flags any whose plan is expensive enough to be worth a human look, using a large, production-shaped dataset so the plans are representative.

Second purpose: **evaluate Drizzle ORM** as a candidate persistence framework — how it feels for **schema definition + migration generation**, and how well its query builder expresses the queries-under-test as a **typed persistence facade** that the harness gates automatically.

**Scope: local only, no CI/CD.** Standalone project. Design is CI-aware (versioned image, harness reads image ref from config) so CI can be added later without rework.

## Domain / data model

Four tables, **chain** relationship:

```
park (id, name)
  └─* pitch (id, park_id, lat, lng)
        └─* van (id, pitch_id, model, grade)
              └─* reservation (id, van_id, start_date, end_date)
```

- **40 parks.**
- Each park: **500–2000 pitches**, one van per pitch (~50k pitches, ~50k vans total).
- **van.model**: one of 10 arbitrary model names.
- **van.grade**: a **`pgEnum`** — saver, bronze, silver, gold, platinum. Enum because grade is a small fixed set, is very likely an **indexed** field, and a 4-byte enum makes a smaller index → better cache residency. Regrades over time extend the enum (`ALTER TYPE ... ADD VALUE`), which also lets the POC exercise how Drizzle generates a realistic schema-evolution migration.
- **reservation**: `start_date`/`end_date`, **3 seasons** of data. Seasonal booking curve: near-fully-booked Jul/Aug, ramping up toward summer and down toward winter, **closed Dec/Jan**. This skew is the point — date-range predicates have very different selectivity by month, which is what makes plan choice interesting. Estimated ~2–3M reservation rows.

## Architecture decisions

1. **Drizzle owns schema + migrations only.** Tables defined in TS; migrations produced by `drizzle-kit generate` (NOT `push`) so the generated `.sql` is a committed, inspectable artifact that doubles as a smoke-test of the migration path. Drizzle snapshots (`migrations/meta/*.json` + `_journal.json`) are the diff source of truth and **must be committed**.
2. **Seed data is generated as raw SQL text by a standalone script** — fast, portable, Drizzle-free. Emits `COPY ... FROM stdin` blocks (not per-row INSERTs) for the millions of reservation rows. Seed is a **regenerable single-state snapshot**, never accumulating deltas (see Future scaling).
3. **The dataset is baked into a Docker image**, post-`VACUUM (FREEZE, ANALYZE)`; the image is the frozen "template". A throwaway container is created per harness run and destroyed after.
   - Bake at **build time** into a **non-volume `PGDATA`** (e.g. `/var/lib/postgresql/baked`), because the official image declares the default data dir a `VOLUME` and build-time writes to a VOLUME are discarded. Container start is then instant (no init).
   - `VACUUM (FREEZE, ANALYZE)` in the build: **FREEZE** stops later transaction-ID-wraparound rewrites that would dirty files at runtime; **ANALYZE** captures the planner stats the harness depends on.
   - **No `CREATE DATABASE ... TEMPLATE` clone.** A container-from-image is already a copy-on-write clone (cheaper than Postgres's physical template copy), and since the harness only gates read paths the data is never mutated. The template-clone step was for the original "tests may mutate" framing and is superseded by read-only gating. (Revisit only if parallelising or gating something that mutates.)
   - **Image versioned by content hash** of (migration files + generated seed). Harness reads the image ref from env/config, defaulting to the pinned published tag; devs override to a locally-built tag when they've changed schema/seed. Unifies "published vs local" with no code change.
4. **Postgres major version: pinned to 18** (`postgres:18`) — explicit tag, never `latest`, because plan quality depends on the major. Mirror prod planner GUCs (`random_page_cost`, `work_mem`, `effective_cache_size`, `default_statistics_target`) in the image config. Note: PG18's planner may pick different plans than the PG15/16 in prod RDS — fine for the POC (evaluating the mechanism), but when picking the real target service the harness's major version should match that service's prod.

## Harness behaviour (see README for full rationale)

- Queries are exported functions in a **persistence facade** (`src/persistence.ts`), built with Drizzle. The harness wraps Drizzle in a **`pg-proxy` driver** that runs `EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS)` on each generated read query, captures the plan, then delegates the real query to node-pg. Only reads are gated; writes/DDL pass through un-analysed.
- The test holds a `GATES` map keyed by facade function name → list of **cases**; each case either `{ run, gate }` (invoke with representative args + limits) or `{ skip: "<reason>" }`. Gates live in the test, keeping the facade free of test concerns.
- **Gates** (per case, global default overridable):
  - `cost` — top-node Total Cost. Default **100**. A "worth checking" tripwire, not a pass target.
  - `rowCountRatio` — `max(actual,plan)/min(actual,plan)`. Default **10**. Tripwire for bad stats; a ratio so proportional data growth doesn't churn it.
- `Actual Total Time` is **captured/reported but not asserted** (hardware-sensitive).
- **Coverage**: the facade is the coverage surface. A test asserts every exported facade function has a `GATES` entry — an ungated function fails as untested. No query can exist outside the facade, so none can escape gating.
- Custom plans only (assumes the app uses node-pg on its unnamed query path → value-optimal custom plans; no generic-plan handling).

## Build steps

1. **Project scaffold** (`dataload-spike/`): standalone TS, ESM, `tsx` for scripts. `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`.
2. **Drizzle schema** — `src/schema/` with the four tables + `gradeEnum` `pgEnum`, indexes matching the queries under test (at minimum: FKs, `van.grade`, `reservation.van_id`, `reservation(start_date, end_date)`). `drizzle.config.ts` → schema + `out = migrations/`.
3. **Generate initial migration** — `drizzle-kit generate` → `migrations/0000_*.sql` + snapshots. Commit them.
4. **Seed generator** — `scripts/generate-seed.ts`: parameterised (park count, seasons, seasonal weight curve, stay-length model), seeded RNG for reproducibility → stable image hash. Emits `seed.sql` using `COPY`.
5. **Dockerfile** — base `postgres:18`; build stage: initdb → apply migrations → apply seed → `VACUUM (FREEZE, ANALYZE)` into a non-volume `PGDATA`; mirror prod GUCs. Plus `docker-compose.yml` for local build-or-pull + throwaway container.
6. **Persistence facade** — `src/persistence.ts`: ~5–6 representative queries as Drizzle functions (date-range availability, park bookings, vans-by-grade, 4-table join, one deliberately-expensive), plus a `vacuumReservation` that the harness skips. Driver-agnostic (`Db = PgDatabase<any>`) so the app can wire it to node-postgres and the harness to the gated pg-proxy driver.
7. **Harness runner** — built on **`node:test`** (zero-dependency). Wrap Drizzle in the pg-proxy gate driver (`test/harness/gate.ts`), then iterate the `GATES` map: a subtest per facade function, a sub-subtest per case. `planOf(call)` invokes the facade function through the gate and returns the single captured plan; assert gates. `skip` → `t.skip(reason)`. **Coverage checked separately** — one test asserts every exported facade function appears in `GATES`, so an ungated function fails as untested. Cost/rowCountRatio surfaced via `diagnostic()` when a gate is breached.

## Future scaling (reasoning captured; NOT built now)

Not needed at POC scale (~300–500MB image).

- **Never make seed additive.** Schema migrations are legitimately forward-only deltas (they replay against real DBs holding data you can't discard). Seed is a disposable build input → express it as a **regenerated single-state snapshot**. Additive seed deltas would grow the build inputs without bound to produce the same end-state. Keep the two disciplines separate.
- **Tablespace-per-layer for large static data.** Docker layer diffs are whole-file (overlayfs copy-up), and Postgres rewrites files via vacuum/freeze/hint-bit-on-first-read — so naive "ship only deltas" doesn't work. The lever that does: put stable reference tables on a **tablespace** written in an early build layer, fully `VACUUM (FREEZE, ANALYZE)`'d so nothing rewrites them later; churning tables on a later layer. The static layer stays cached; only the churning layer re-downloads. Caveat: `pg_statistic`/catalog lives in the default tablespace, so a small catalog delta remains even when static data doesn't change.
- **The version that really pays off: tablespace-partition reservations by season.** Reservations are append-mostly — closed seasons never change. Aligning the layer boundary with Postgres's real mutation boundary (the current season) means each past season becomes a permanent cached layer and only the current season rebuilds. This is the sound version of the "ship deltas" instinct.
- **Registry bloat is a retention problem, not fundamental.** Each tag is independent layers; old data accumulates only if old tags are kept. Solve with a GC/lifecycle policy (keep last N) + optional squash.

## Notes / caveats

- Postgres core has **no query planner hints** (Oracle-style `/*+ ... */`); `pg_hint_plan` is out-of-tree. Reinforces the harness's value — you can't hint away a bad plan in prod, so catching it early via cost is the real lever. (Distinct from **hint bits**, an internal MVCC commit-status flag set lazily on first read — one of the things that dirties "static" files at runtime, hence the FREEZE.)
- Facade queries built with Drizzle's query builder are **type-checked against the schema** — a column rename surfaces at compile time, not runtime. The trade is that gating happens through a `pg-proxy` driver whose read/write classification is string-based (`isRead`); watching how that heuristic holds up is an explicit evaluation goal.

## Verification

- `docker compose up` (build or pull) → container healthy, DB populated, stats present (`SELECT * FROM pg_stats WHERE tablename='reservation'` non-empty).
- Run the harness: gates every facade function through the pg-proxy driver, runs `EXPLAIN ANALYZE`, prints costs, fails the deliberately-expensive query, passes cheap ones, honours per-case overrides, skips `vacuumReservation`, and fails coverage if a facade function has no `GATES` entry.
- Spot-check a July date-range query vs a November one produce **different** plans/costs (proves the seasonal distribution works).
- Row counts identical before/after a full run (rollback works).
- Capture Drizzle evaluation notes: how `generate` felt, readability of the generated migration SQL, and how naturally the query builder + pg-proxy gate express the facade.

## Open question (non-blocking)

- Whether to also build a template from **prod-shaped existing data** to validate that migrations correctly migrate *existing* data (not just apply cleanly to an empty DB). Out of scope for this POC.
