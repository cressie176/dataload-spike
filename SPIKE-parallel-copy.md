# Spike: parallel COPY by park

Does splitting the seed into independent per-park chunks and COPYing them
concurrently close the gap on serial COPY — and where's the ceiling?

Reproduce: `npm run generate:seed && npm run benchmark:parallel-copy`
(harness: `scripts/benchmark-parallel-copy.sh`; postgres:18 with prod GUCs;
same 4.14M-row dataset loaded four ways, schema reset between runs).

## Results

| Method | Wall-clock | Speedup |
|--------|-----------:|--------:|
| A) serial COPY (`seed.sql`) | 24.3 s | 1.0× |
| B) parallel COPY `-j4`, logged | 10.9 s | 2.2× |
| C) parallel COPY `-j8`, logged | 9.6 s | 2.5× |
| D) parallel COPY `-j8`, **unlogged** | 6.6 s | 3.7× |

All four produced identical row counts (40 parks, 47,328 pitches/vans,
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
another 31% (9.6 s → 6.6 s, 2.5× → 3.7×). That delta is the WAL cost: WAL was
the dominant bottleneck capping the logged parallel runs, exactly as expected —
every worker funnels through the same WAL flush path.

Index maintenance is the remaining shared cost (all four tables are indexed from
the migration, so concurrent COPY contends on index inserts). Dropping and
recreating indexes around the load is a separate, additive lever not tested here.

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

For the build-time bake, adopt **parallel COPY by park on UNLOGGED tables**
(3.7× here): the bake stops the cluster cleanly (`pg_ctl stop -w`) and the image
is a read-only template, so the unlogged crash-safety caveat doesn't bite. If we
want the baked tables logged in the final image, `SET LOGGED` after the load
rewrites+WAL-logs them (paying the WAL cost back once, serially) — measure
whether that erases the win before committing to it.

Worker-thread *generation* (the original idea) is not worth it yet: the spike
showed generation is already cheap; the cost is on the write side, which parallel
COPY addresses directly without leaving bash.
