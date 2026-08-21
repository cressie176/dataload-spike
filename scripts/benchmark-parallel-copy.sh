#!/usr/bin/env bash
# Parallel-COPY load benchmark.
#
# Question: does splitting the seed into per-park chunks and COPYing them
# concurrently close the gap on serial COPY — and where's the ceiling (index
# maintenance vs WAL)?
#
# Brings up an empty postgres:18 with the prod planner GUCs (same as
# docker/build-db.sh), applies migrations, then times several loads of the SAME
# data against the same cluster, resetting the schema between each:
#   A) serial COPY            psql -f seed.sql            (baseline)
#   B) parallel COPY  -j4     parallel psql -f chunk      (logged tables)
#   C) parallel COPY  -j8     parallel psql -f chunk      (logged tables)
#   D) parallel COPY  -j8     parallel psql -f chunk      (UNLOGGED tables)
# D vs C isolates the WAL cost: same parallelism, WAL turned off.
#
# Requires: seed.sql + chunks/ (run `npm run generate:seed` first) and GNU parallel.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

CONTAINER=parkdata-pbench
PORT=5434
DB_USER=harness
DB_PASS=harness
DB_NAME=parkdb
SEED_SQL="$HERE/seed.sql"
CHUNK_DIR="$HERE/chunks"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

command -v parallel >/dev/null || { echo "GNU parallel not found — brew install parallel" >&2; exit 1; }
[[ -f "$SEED_SQL" ]] || { echo "seed.sql not found — run 'npm run generate:seed' first." >&2; exit 1; }
ls "$CHUNK_DIR"/park-*.sql >/dev/null 2>&1 || { echo "chunks not found — run 'npm run generate:seed' first." >&2; exit 1; }

echo ">> starting postgres:18 ($CONTAINER) on :$PORT"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=$DB_USER -e POSTGRES_PASSWORD=$DB_PASS -e POSTGRES_DB=$DB_NAME \
  -p $PORT:5432 --tmpfs /var/lib/postgresql \
  postgres:18 \
  -c random_page_cost=1.1 -c work_mem=16MB -c effective_cache_size=4GB \
  -c default_statistics_target=100 >/dev/null

echo ">> waiting for readiness"
for _ in $(seq 1 60); do
  state=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  if [[ "$state" != "running" ]]; then
    echo "container is '$state' (exited during startup):" >&2
    docker logs "$CONTAINER" 2>&1 | tail -20 >&2
    exit 1
  fi
  docker exec "$CONTAINER" pg_isready -U $DB_USER -d $DB_NAME >/dev/null 2>&1 && break
  sleep 0.5
done
sleep 1

psql_run() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U $DB_USER -d $DB_NAME "$@"; }

apply_migrations() {
  for f in $(ls migrations/*.sql | sort); do psql_run -f - < "$f" >/dev/null; done
}

reset_schema() {
  psql_run -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
  apply_migrations
}

set_unlogged() {
  psql_run -c "ALTER TABLE reservation SET UNLOGGED; ALTER TABLE van SET UNLOGGED; ALTER TABLE pitch SET UNLOGGED; ALTER TABLE park SET UNLOGGED;" >/dev/null
}

rowcounts() {
  psql_run -tA -c "SELECT t||'='||c FROM (SELECT 'park' t, count(*) c FROM park UNION ALL SELECT 'pitch', count(*) FROM pitch UNION ALL SELECT 'van', count(*) FROM van UNION ALL SELECT 'reservation', count(*) FROM reservation) s;" | tr '\n' ' '
}

# Load all park chunks concurrently at -j $1, then run the sequence-reset finalize.
# Each chunk is an independent psql over its own connection (its own transaction),
# so N chunks COPY in parallel. --halt now,fail=1 aborts the whole load if any
# chunk errors (so a partial load never reports a bogus time).
parallel_load() {
  local jobs=$1
  ls "$CHUNK_DIR"/park-*.sql \
    | parallel --halt now,fail=1 -j "$jobs" \
        "docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U $DB_USER -d $DB_NAME -f - < {}" \
        >/dev/null
  psql_run -f - < "$CHUNK_DIR/_finalize.sql" >/dev/null
}

time_it() { # prints elapsed seconds for the command in $@
  local start end
  start=$(date +%s.%N)
  "$@"
  end=$(date +%s.%N)
  echo "$end - $start" | bc
}

# ---- A) serial COPY ----
echo ">> [A] serial COPY (psql -f seed.sql)"
reset_schema
A_SECS=$(time_it bash -c "docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U $DB_USER -d $DB_NAME -f - < '$SEED_SQL' >/dev/null")
A_COUNTS=$(rowcounts)

# ---- B) parallel COPY -j4 (logged) ----
echo ">> [B] parallel COPY -j4 (logged)"
reset_schema
B_SECS=$(time_it parallel_load 4)
B_COUNTS=$(rowcounts)

# ---- C) parallel COPY -j8 (logged) ----
echo ">> [C] parallel COPY -j8 (logged)"
reset_schema
C_SECS=$(time_it parallel_load 8)
C_COUNTS=$(rowcounts)

# ---- D) parallel COPY -j8 (unlogged: WAL off) ----
echo ">> [D] parallel COPY -j8 (unlogged)"
reset_schema
set_unlogged
D_SECS=$(time_it parallel_load 8)
D_COUNTS=$(rowcounts)

fmt() { printf '%.2f' "$1"; }
mult() { echo "scale=2; $A_SECS / $1" | bc; }

echo
echo "======================= RESULTS ======================="
printf 'A) serial COPY          : %7s s   [%s]\n' "$(fmt "$A_SECS")" "$A_COUNTS"
printf 'B) parallel -j4 logged  : %7s s   [%s]  %sx\n' "$(fmt "$B_SECS")" "$B_COUNTS" "$(mult "$B_SECS")"
printf 'C) parallel -j8 logged  : %7s s   [%s]  %sx\n' "$(fmt "$C_SECS")" "$C_COUNTS" "$(mult "$C_SECS")"
printf 'D) parallel -j8 UNLOGGED : %7s s   [%s]  %sx\n' "$(fmt "$D_SECS")" "$D_COUNTS" "$(mult "$D_SECS")"
echo "-------------------------------------------------------"
printf 'speedup vs serial = A/method.  D vs C isolates the WAL cost at -j8.\n'
echo "======================================================="
