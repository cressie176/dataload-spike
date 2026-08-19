# Query Cost Test Harness — Spike

A spike for validating that every SQL query in the codebase produces an acceptable query plan cost, using `EXPLAIN ANALYZE` against a large, prod-shaped Postgres dataset baked into a disposable Docker image.

> Companion doc: [`PLAN.md`](./PLAN.md) is the implementation build sheet. This README is the design rationale (the *why*).

## Goal

Under a traffic spike (e.g. after a marketing email), the example system can see **thousands of concurrent users at once**. At that concurrency a single bad query plan (e.g. an unexpected sequential scan on a hot table) is catastrophic, whereas query *planning* overhead is negligible. This harness targets **plan quality**: it runs every query, captures its cost, and fails any query whose cost exceeds an acceptable threshold.

## Approach

Bake a large, prod-shaped dataset into a **Docker image** (post-`VACUUM (FREEZE, ANALYZE)`). Each run spins up a **throwaway container** from that image, runs the query checks (each fully isolated by `BEGIN … ROLLBACK`), and destroys the container. The image *is* the frozen "template".

### Where it runs: Docker

The harness runs against a **Docker Postgres**, both **locally** and (later) in **CI/CD**. It must be fast, free, and ephemeral in both places — provisioning RDS per developer and per pipeline run would be slow, costly, and a credentials/teardown burden. Docker gives every developer and the pipeline an identical, disposable instance in seconds.

Plan/cost fidelity does **not** depend on the infrastructure — RDS is just Postgres, and a container produces identical plans. Parity that matters comes from:

- **Pinning the image to prod's Postgres major version** (planner behaviour changes between majors). This POC pins `postgres:18`.
- **Mirroring prod's planner GUCs** — `random_page_cost`, `work_mem`, `effective_cache_size`, `default_statistics_target`.

`cost` and `rowCountRatio` are **hardware-independent** and therefore trustworthy in any environment. `Actual Total Time` is **hardware-sensitive** — numbers differ between a laptop and a CI runner and won't reflect prod latency — so it is captured and reported but never gated (see [Assertion](#assertion)).

### Provisioning: bake once into an image, no template clone

The dataset is built **once, at image build time**, and frozen into the image:

1. `initdb` a fresh cluster into a **non-volume `PGDATA`** (e.g. `/var/lib/postgresql/baked`). The official `postgres` image declares the default data dir a `VOLUME`, and build-time writes to a VOLUME path are discarded — so we bake into a non-volume path.
2. Apply the **Drizzle-generated migration scripts** (same artifacts a real deploy would use) — this doubles as a migration smoke-test.
3. Apply the **generated seed** (`COPY`-based, prod-shaped distribution — see below).
4. `VACUUM (FREEZE, ANALYZE)` — **load-bearing twice over**: `ANALYZE` captures the planner stats plans depend on; `FREEZE` marks tuples so Postgres won't rewrite their files later for transaction-ID wraparound (which would otherwise dirty "static" files at container runtime and defeat image-layer caching).

**No `CREATE DATABASE ... TEMPLATE` clone.** A container created from the image is already a copy-on-write clone of the baked data (cheaper than Postgres's physical template copy, which is an intra-server file copy). Because every query runs inside `BEGIN … ROLLBACK`, the data is never mutated, so a single baked database stays pristine across the whole run. The template-clone approach was designed for the earlier "tests may mutate data" framing; rollback-per-query supersedes it. (Reintroduce cloning only if you later parallelise, or run something that can't be rolled back.)

**Image versioning.** Tag the image by a content hash of its inputs (migration files + generated seed). The harness reads the image ref from env/config, defaulting to the pinned published tag; a developer who changes schema or seed builds locally under the new hash and the harness picks it up — no code change. This unifies "use the published image" and "use my local build".

### Seed data distribution

The planner's choices depend on the statistical shape of the data — `n_distinct`, most-common-values, histogram bounds, `null_frac`, and physical/logical correlation — not just row counts. Uniform synthetic data can produce plans that diverge from prod. The seed process should approximate **prod cardinality and skew**.

Match prod planner configuration too, since these live in config rather than the template:

- `random_page_cost`
- `work_mem`
- `effective_cache_size`
- `default_statistics_target`

### Per-query execution

Every query — **including `SELECT`s** — is wrapped uniformly:

```sql
BEGIN;
EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) <query with params>;
ROLLBACK;
```

Uniform wrapping means the harness never needs to classify statements as read vs. write. `EXPLAIN ANALYZE` **executes** the query, so any mutation (including writing CTEs, `SELECT ... FOR UPDATE`, or volatile functions) would otherwise contaminate the data distribution that subsequent queries' plans depend on. The `ROLLBACK` keeps the database pristine for every query.

### Assertion

Parse the JSON output and gate on two signals, each an optional per-query threshold (see [Coverage and parameters](#coverage-and-parameters)):

- **`cost`** — top-node `Total Cost` (planner estimate, arbitrary units). Global default **100**, overridable per param set. This is a **"worth checking" tripwire, not a pass target**: a query under 100 is unlikely to cause a production issue and passes silently; a query over 100 is flagged as worth a human look — either optimise it, or acknowledge it's fine with an explicit per-query override. Expect a meaningful fraction of queries to need overrides; that's the mechanism working, not failing.
- **`rowCountRatio`** — **row mis-estimate ratio**: `max(Actual Rows, Plan Rows) / min(Actual Rows, Plan Rows)`, i.e. "the planner was off by Nx". Global default **10**, overridable per param set. This is a *tolerance*, not a target: a coarse tripwire for the planner being badly wrong, which is the strongest signal of stale/inaccurate statistics behind a bad plan.

`cost` flags queries expensive enough to be worth checking; `rowCountRatio` catches the root cause of most bad plans (stale stats behind a bad estimate). Together they cover the dominant failure mode for this workload.

**Why a *ratio*, and why loose:** gating on the ratio (not absolute row counts) means proportional data growth doesn't cause churn — estimate and actual scale together, so the ratio holds; it only moves when the data changes *shape*, which is exactly when plans flip. The default of 10 is a starting point: healthy multi-join queries can legitimately mis-estimate by several x (errors compound up a join tree), so **if 10 proves flaky on real seed data, loosen it (or override the offending queries) promptly** rather than letting failures get ignored. Ratchet toward the tightest value that isn't noisy.

**`Actual Total Time` is captured and reported, but not asserted on.** It's hardware-sensitive — a value that's stable and meaningful on prod hardware would be flaky on a CI runner and toothless on a fast laptop — so it can't be a reliable gate here (Docker, locally + CI). It's still worth surfacing in the run output as a diagnostic: if a query passes on `cost`/`rowCountRatio` but took surprisingly long, that's a signal for a human to investigate (e.g. an expensive function or a `work_mem` spill the cost model doesn't represent).

### Coverage and parameters

All queries live in a **folder**, one `.sql` file per query. (Migration scripts live in a *separate* folder and are out of scope for this harness.) Each query's test metadata is embedded **inline in the SQL file** as a single structured block comment, keyed `@test`:

```sql
/* @test
params:
  - { values: { park_id: 42 }, thresholds: { cost: 250, rowCountRatio: 5 } }
  - { values: { park_id: 7 },  thresholds: { cost: 900 } }
*/
SELECT * FROM bookings WHERE park_id = $1;
```

- **`params`** — parameter sets. The values are part of the test contract, because plans depend on the specific values under data skew. Use **multiple sets per query** where relevant (typical case + worst case), each with its own thresholds. Sets are referenced by **index** in output (e.g. `bookings.sql [param 1]`).
- **`thresholds`** — per-param-set gates (`cost`, `rowCountRatio`), each optional and falling back to its global default when omitted (`cost` 100, `rowCountRatio` 10). See [Assertion](#assertion). (`Actual Total Time` is reported but not gated.)

**Explicit skip.** Some SQL can't or shouldn't be cost-tested — e.g. a maintenance script like `VACUUM (ANALYZE)`, which **cannot run inside a transaction block** and so can't even go through the `BEGIN … ROLLBACK` wrapper, let alone be planned. Such files carry a `skip` with a **required, non-empty reason** instead of `params`:

```sql
/* @test
skip: "VACUUM cannot run inside a transaction block"
*/
VACUUM (ANALYZE) bookings;
```

The reason is mandatory so skips stay auditable — the harness prints a summary of skipped queries so they remain visible rather than quietly accumulating. Skip is a deliberate, reason-bearing opt-out; it is **not** the same as a missing block (which is a failure).

**Why inline over sidecar files:** the test contract lives exactly where the query does, so it can't drift away from or be orphaned from the query, and it keeps the file count down. The `.sql` file remains runnable as-is — Postgres ignores comments.

**Why a single structured block over scattered `-- @key value` lines:** the metadata is structured data (a list of records), not scalars. Embedding one YAML/JSON block and handing it to a real parser avoids inventing a fragile bespoke comment DSL. Postgres supports `/* ... */` block comments (they even nest), so the whole payload sits in one comment and the file still runs unchanged.

**Coverage detection.** Because every query file exists regardless of whether it's tested, coverage is no longer "does a sibling file exist?" — it's "does this file contain a valid, parseable `@test` block?". The parser must be **strict**:

- No `@test` block → untested → **fail**.
- `@test` block with neither `params` nor `skip`, or otherwise malformed/empty → broken test → **fail loudly** (distinct from untested; never silently pass or count as untested).
- `@test` with a valid `skip: "<reason>"` → recorded as skipped and reported in the summary.

### Plan mode: custom plans only

The harness validates **custom** (value-aware) plans, which matches the assumed production setup: the app uses **node-pg on its default unnamed query path**, so Postgres replans every execution with the actual parameter values and never switches to a value-blind generic plan. No `force_generic_plan` handling is required.

> Revisit only if a grep for `name:` in `.query(` call sites reveals **named prepared statements** — those are subject to the custom→generic plan switch after ~5 executions and would need separate treatment.

## Per-query sequence

```
BUILD (once, offline):
  initdb → apply migrations → apply seed → VACUUM (FREEZE, ANALYZE)
  → bake into image, tag by content hash of (migrations + seed)

RUN:
  start throwaway container from the baked image
  discover queries/*.sql  → assert every file has a valid @test block (coverage)
  for each query file:
    parse inline @test block  (skip → record & continue; missing/malformed → fail)
    for each param set:
      BEGIN
      EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) <query> with param values
      parse JSON → Total Cost, Plan/Actual Rows, Actual Total Time
      assert cost <= thresholds.cost                     (default 100)
      assert rowCountRatio <= thresholds.rowCountRatio   (default 10)
      report Actual Total Time  (diagnostic only, not asserted)
      ROLLBACK
  destroy container
```

## Future scaling

None of this is needed at POC scale (~300–500MB image), but the reasoning is captured so it isn't lost.

- **Never make the seed additive.** Schema migrations are legitimately forward-only deltas — they replay against real databases that already hold data you can't discard. The **seed is different**: it's a disposable build input that only ever populates a throwaway image, so it should be a **regenerated single-state snapshot**, not an accumulating chain of `seed_0001`, `seed_0002`, … Additive seed deltas would grow the build inputs without bound just to produce the same end-state. Keep the two disciplines separate: migrations accrete, seed regenerates.
- **Tablespace-per-layer for large static reference data.** Docker layer diffs are whole-file (overlayfs copy-up), and Postgres rewrites files behind your back (vacuum, freeze, hint-bit-on-first-read) — so a naive "ship only the changed rows as a delta layer" doesn't work. The lever that does: put stable reference tables (park, pitch, van) on a **tablespace** written in an *early* build layer, fully `VACUUM (FREEZE, ANALYZE)`'d so nothing rewrites them afterward; put churning tables on a *later* layer. The static layer stays cached and only the churning layer re-downloads. Caveat: `pg_statistic` and the rest of the catalog live in the default tablespace, so a small catalog delta remains even when the static *data* doesn't change.
- **The version that really pays off: partition reservations by season onto per-season tablespaces.** Reservations are append-mostly — a closed season never changes again. Aligning the layer boundary with Postgres's real mutation boundary (the current season) means each past season becomes a permanent cached layer, and only the current season's layer rebuilds. This is the sound realisation of the "just ship the deltas" instinct — it works precisely because it follows Postgres's own immutability boundary instead of fighting it.
- **Registry bloat is a retention problem, not a fundamental one.** Each image tag is an independent set of layers; old data accumulates only if you keep old tags. Solve it with a GC/lifecycle policy (keep last N tags) plus optional squashing — not by changing the bake approach.

## Open questions

- Whether the harness should also build from **prod-shaped existing data** — validating that migrations correctly migrate *existing* data, not just that they apply cleanly to an empty database. Out of scope for this POC.
