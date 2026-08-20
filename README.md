# Query Cost Test Harness — Spike

Validates that every query in the codebase produces an acceptable query plan, by running `EXPLAIN ANALYZE` against a large, prod-shaped Postgres dataset baked into a disposable Docker image. Queries are Drizzle functions in a persistence facade; the harness gates them by wrapping Drizzle in a driver that EXPLAINs each generated query before it runs.

See [`PLAN.md`](./PLAN.md) for the build sheet. This is the design rationale.

## Goal

Under a traffic spike (e.g. a marketing email) the system can see thousands of concurrent users. At that concurrency a single bad plan — an unexpected seq scan on a hot table — is catastrophic, while planning overhead is negligible. So the harness targets plan *quality*: run every query, capture its cost, fail anything over threshold.

## Where it runs: Docker

The harness runs against a Docker Postgres, locally and (later) in CI. Provisioning RDS per developer and per pipeline run would be slow, costly, and a teardown burden; Docker gives everyone an identical, disposable instance in seconds.

Plan fidelity doesn't depend on the infrastructure — a container produces the same plans as RDS. What matters for parity:

- **Pin the Postgres major version** (the planner changes between majors). This POC pins `postgres:18`; match prod's major when picking a real target.
- **Mirror prod's planner GUCs** — `random_page_cost`, `work_mem`, `effective_cache_size`, `default_statistics_target`.

`cost` and `rowCountRatio` are hardware-independent, so they're trustworthy anywhere. `Actual Total Time` is not (see [Gates](#gates)).

## Provisioning: bake once into an image

The dataset is built once at image build time and frozen in:

1. `initdb` into a **non-volume `PGDATA`**. The official image declares the default data dir a `VOLUME`, and build-time writes to a VOLUME are discarded — so bake elsewhere.
2. Apply the **Drizzle-generated migrations** (the same artifacts a deploy uses — doubles as a migration smoke-test).
3. Apply the **generated seed** (`COPY`-based, prod-shaped — see below).
4. `VACUUM (FREEZE, ANALYZE)`. `ANALYZE` captures the planner stats; `FREEZE` stops Postgres rewriting tuple files later for txid wraparound, which would otherwise dirty "static" files at runtime and break layer caching.

**No `TEMPLATE` clone.** A container from the image is already a copy-on-write clone of the baked data. The harness only gates reads, so the data never mutates and one baked database stays pristine for the whole run. (Add cloning only if you parallelise or gate something that mutates.)

**Image versioning.** Tag by a content hash of the inputs (migrations + seed). The harness reads the image ref from config, defaulting to the published tag; change the schema or seed and you build locally under a new hash that the harness picks up automatically.

## Seed data distribution

The planner's choices depend on the *shape* of the data — `n_distinct`, MCVs, histogram bounds, `null_frac`, correlation — not just row counts. Uniform synthetic data produces plans that diverge from prod, so the seed approximates prod cardinality and skew.

## Queries: the persistence facade

Queries are functions in a persistence facade (`src/persistence.ts`), built with Drizzle. The harness wraps Drizzle in a `pg-proxy` driver (`test/harness/gate.ts`): every query the facade generates passes through the driver as a parameterised string, which runs

```sql
EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) <generated query>
```

captures the plan, then delegates the real query to node-pg. Calling a facade function is all it takes to gate it — there's no separate catalogue to keep in sync, and Drizzle-generated SQL (joins, `where` clauses) is covered automatically.

`EXPLAIN ANALYZE` *executes* the query, so the driver only gates reads (SELECT/CTE/`TABLE`); writes and DDL pass through un-analysed. A facade function that mutates should use a plain `EXPLAIN` or be skipped.

## Gates

Parse the plan JSON and gate on two signals:

- **`cost`** — top-node `Total Cost`. Default **100**. A "worth checking" tripwire, not a pass target: under 100 passes silently, over 100 is flagged for a human to either optimise or explicitly override. Expect a fair number of overrides — that's the mechanism working.
- **`rowCountRatio`** — `max(Actual, Plan) / min(Actual, Plan)`, i.e. how many x the planner was off. Default **10**. A coarse tripwire for bad stats behind a bad plan.

The ratio (not absolute row counts) means proportional data growth doesn't cause churn — estimate and actual scale together; the ratio only moves when the data changes *shape*, which is when plans flip. 10 is a starting point: multi-join queries legitimately compound estimation error, so loosen it if it proves flaky, and ratchet toward the tightest non-noisy value.

**`Actual Total Time` is reported but not gated** — it's hardware-sensitive, so it'd be flaky on CI and toothless on a fast laptop. Still worth surfacing: a query that passes cost/ratio but runs slow is a signal for a human to look (e.g. a `work_mem` spill the cost model doesn't capture).

## Coverage

The facade *is* the coverage surface. The test (`test/performance.test.ts`) holds a `GATES` map keyed by facade function; each entry is a list of cases that either invoke the function with representative args and a gate, or declare a skip:

```ts
const GATES: Record<keyof typeof facade, Case[]> = {
  parkBookings: [
    { run: (db) => facade.parkBookings(db, 7, "2025-02-01", "2025-11-30"), gate: { cost: 30000 } },
  ],
  vansByGrade: [
    { run: (db) => facade.vansByGrade(db, "saver"),    gate: { cost: 2000 } },
    { run: (db) => facade.vansByGrade(db, "platinum"), gate: { cost: 2000 } },
  ],
  vacuumReservation: [{ skip: "VACUUM cannot run inside a transaction block" }],
};
```

- **Arguments** are part of the contract — plans depend on the specific values under skew. Use multiple cases (typical + worst) where it matters.
- **`gate`** — per-case `cost`/`rowCountRatio`, each falling back to the default when omitted.
- **`skip`** — a reason-bearing opt-out for a function that can't be cost-tested. The reason keeps skips auditable.

Gates live in the test, not the facade: the facade is production code, so thresholds and test arguments stay out of it.

A dedicated test asserts **every exported facade function has a `GATES` entry** — an ungated function fails as untested. This is the advantage over externalised `.sql` files: a query can't exist outside the facade, and no facade function can escape gating.

## Custom plans only

The harness validates custom (value-aware) plans, matching the assumed prod setup: the app uses node-pg on its default unnamed query path, so Postgres replans per execution with actual values and never switches to a generic plan. Revisit only if `name:` in `.query()` call sites reveals named prepared statements, which flip custom→generic after ~5 executions.

## Sequence

```
BUILD (once, offline):
  initdb → migrations → seed → VACUUM (FREEZE, ANALYZE)
  → bake into image, tag by content hash of (migrations + seed)

RUN:
  start throwaway container
  assert every facade function has a GATES entry
  for each function, for each case:
    skip → record & continue
    call facade.fn(gatedDb, ...args)
      → driver EXPLAINs the generated SQL, captures the plan, runs the real query
    assert cost <= gate.cost               (default 100)
    assert rowCountRatio <= gate.ratio     (default 10)
    report Actual Total Time               (diagnostic only)
  destroy container
```

## Future scaling

Not needed at POC scale (~300–500MB image), captured so it isn't lost.

- **Never make the seed additive.** Migrations are forward-only deltas because they replay against real data. The seed only populates a throwaway image, so it's a regenerated single-state snapshot — additive seed deltas would grow the build inputs without bound to reach the same end-state.
- **Tablespace-per-layer for static reference data.** Docker layer diffs are whole-file, and Postgres rewrites files behind your back (vacuum, freeze, hint bits), so "ship only the changed rows" doesn't work. Instead put stable tables (park, pitch, van) on a tablespace in an early, fully-frozen layer and churning tables in a later one; the static layer stays cached. (The catalog lives in the default tablespace, so a small delta remains.)
- **Partition reservations by season onto per-season tablespaces.** Reservations are append-mostly and closed seasons never change, so aligning the layer boundary with the current season makes each past season a permanent cached layer and rebuilds only the current one.
- **Registry bloat is a retention problem.** Each tag is independent layers; solve with a keep-last-N lifecycle policy, not by changing the bake.

## Open questions

- Whether to also build from prod-shaped *existing* data, to validate that migrations transform existing rows correctly rather than just applying to an empty DB. Out of scope for this POC.
