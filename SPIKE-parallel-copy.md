# Spike: parallel COPY by park

Does splitting the seed into independent per-park chunks and COPYing them
concurrently close the gap on serial COPY — and where's the ceiling?

Reproduce: `npm run generate:seed && npm run benchmark:parallel-copy`
(harness: `scripts/benchmark-parallel-copy.sh`; postgres:18 with prod GUCs;
same 4.14M-row dataset loaded four ways, schema reset between runs).

## Results

One representative run (host load causes run-to-run variance of a second or so;
the ordering is stable):

| Method | Wall-clock | Speedup |
|--------|-----------:|--------:|
| A) serial COPY (`seed.sql`) | 27.6 s | 1.0× |
| B) parallel COPY `-j4`, logged | 12.2 s | 2.3× |
| C) parallel COPY `-j8`, logged | 11.4 s | 2.4× |
| D) parallel COPY `-j8`, **unlogged** | 8.1 s | 3.4× |
| E) D + drop/rebuild secondary indexes | 7.7 s | 3.6× |

All five produced identical row counts (40 parks, 47,328 pitches/vans,
4,140,391 reservations) — the partition-by-park split loads the same data.

## Findings

### Parallel COPY is a big, cheap win — no Node, no worker threads
2.2–2.5× just by splitting `seed.sql` into per-park chunks and running
`ls chunks/park-*.sql | parallel -j N psql -f {}`. The generator tees each
park's whole subtree (park → pitches → vans → reservations) into its own chunk
during the same deterministic pass that writes `seed.sql`, so there's no extra
generation cost and the chunks are byte-consistent with the monolith.

### The ceiling at -j8 is WAL, not CPU
Going -j4 → -j8 added only ~14% (2.2× → 2.5×): doubling workers barely helped,
so past ~4 workers we're not CPU-bound — the parallel COPY streams serialize on
a shared resource. Turning WAL off (unlogged, method D) at the SAME -j8 cut
another 29% (11.4 s → 8.1 s, 2.4× → 3.4×). That delta is the WAL cost: WAL was
the dominant bottleneck capping the logged parallel runs, exactly as expected —
every worker funnels through the same WAL flush path.

### Drop indexes for the load, bulk-rebuild after — adopted
Method E drops the five secondary indexes, loads index-free, then bulk-rebuilds
them — timed end-to-end. On this spike dataset it came in at 7.7 s vs D's 8.1 s:
only ~5% faster, because the bulk `CREATE INDEX` pass pays back most of the
index-free COPY saving.

**But this gap widens with scale, so we adopt it.** The spike carries five small
indexes over ~4M rows; the real dataset is far bigger and has many more indexes.
Maintaining N indexes incrementally under concurrent COPY costs more per extra
index (random page writes, contention) than rebuilding each once in a bulk pass
that gets `maintenance_work_mem` to itself — so the ~5% here is a floor, not a
ceiling. A small measured win that grows with row/index count is worth taking.

The usual objection to drop/rebuild — hand-syncing index DDL with the migration —
doesn't apply: `build-db.sh` reads the `CREATE INDEX` defs straight from the
catalog (`pg_get_indexdef`) before dropping, so it tracks whatever the migrations
create with zero hand-maintained SQL. "Secondary" = not a primary key and not
backing a constraint (PKs / unique indexes stay, since FKs depend on them). The
rebuild runs while the tables are still UNLOGGED, so it skips WAL too; `SET LOGGED`
then WAL-logs tables and their fresh indexes together in one pass.

### Why partition by park (root aggregate), not "entities then relationships"
The FK graph is a chain, so children need parent IDs. Generating entities
independently and wiring relationships in a second pass would mean a full extra
pass over millions of rows. Partitioning by park instead gives each worker a
disjoint subtree with zero cross-chunk references — no join-up phase at all.
Sequences are global, so the only shared step is a one-shot `_finalize.sql`
(the `setval`s) after all chunks load.

### Determinism is preserved
The generator runs once, serially, over a single RNG stream in fixed order, so
output stays byte-stable — the image content-hash / caching scheme is unaffected.
Splitting deterministic output into chunks is trivially deterministic; verified
that two runs produce an identical `seed.sql` hash and that the concatenated
chunks contain exactly the same row set.

## Recommendation

For the build-time bake, adopt **parallel COPY by park into UNLOGGED tables, with
secondary indexes dropped for the load and bulk-rebuilt after, then `SET LOGGED`**
— now wired into `docker/build-db.sh`. The full bake sequence, all while unlogged:
drop secondary indexes → parallel COPY the chunks → bulk-rebuild the indexes →
`SET LOGGED` (WAL-logs tables and their fresh indexes together, once). The image
ends crash-safe: all four tables `relpersistence = 'p'` and all five secondary
indexes valid — verified.

`SET LOGGED` re-pays the WAL cost once, serially, but end-to-end still wins.
Measured inside the bake (postgres:18, `-P 8`):

| Step | Wall-clock |
|------|-----------:|
| parallel COPY (unlogged) | ~6.3 s |
| `SET LOGGED` (rewrite → WAL) | ~5.6 s |
| **total** | **~12 s** vs ~24 s serial logged → **~2× faster** |

So we keep the crash-safe logged image *and* roughly halve the load phase.

Worker-thread *generation* (the original idea) is not worth it yet: the spike
showed generation is already cheap; the cost is on the write side, which parallel
COPY addresses directly without leaving bash.
