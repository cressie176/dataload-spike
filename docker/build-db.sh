#!/usr/bin/env bash
# Build-time bake: initialise a cluster in a NON-VOLUME path, apply migrations +
# seed, mirror prod planner GUCs, then VACUUM (FREEZE, ANALYZE).
#
# Non-volume PGDATA is deliberate: the official image declares the default data
# dir a VOLUME, and build-time writes to a VOLUME are discarded. In postgres:18
# the VOLUME is the whole /var/lib/postgresql tree, so we bake into /var/lib/pgbaked
# (outside it). This survives into the image, so container start is instant
# (the entrypoint sees an initialised PGDATA and skips initdb).
#
# FREEZE + ANALYZE are load-bearing: ANALYZE captures the planner stats the harness
# depends on; FREEZE marks tuples so Postgres won't rewrite their files later for
# txid wraparound, which would dirty "static" files at runtime and defeat layer caching.
set -euo pipefail

PGDATA=/var/lib/pgbaked
DB_USER=harness
DB_PASS=harness
DB_NAME=parkdb

export PGDATA

# Timestamped progress so a long bake is observable in `docker build` output
# (run with --progress=plain to stream it live).
BUILD_START=$(date +%s)
step() {
  local now elapsed
  now=$(date +%s)
  elapsed=$((now - BUILD_START))
  printf '>> [%3ds] %s\n' "$elapsed" "$1"
}

mkdir -p "$PGDATA"
chown -R postgres:postgres "$PGDATA" /work

# initdb (as postgres). Superuser role = harness. Auth is split by connection
# type: local socket = trust (build-time psql runs as OS user postgres and must
# connect WITHOUT a password, else it prompts forever on non-interactive stdin);
# host/TCP = scram-sha-256 (the runtime harness authenticates over TCP). Set the
# role password separately via ALTER ROLE so TCP auth works at runtime.
step "initdb"
su postgres -c "initdb --username=$DB_USER --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8"

# Mirror prod planner GUCs BEFORE ANALYZE (default_statistics_target must be in
# effect when stats are gathered). Values chosen to resemble an RDS gp3 instance.
cat >> "$PGDATA/postgresql.conf" <<'CONF'

# --- Harness: mirror prod planner configuration ---
random_page_cost = 1.1
work_mem = '16MB'
effective_cache_size = '4GB'
default_statistics_target = 100
# Listen only on the socket during build; runtime overrides via command.
listen_addresses = ''
CONF

# initdb --auth-host already wrote the scram host rule; widen it to any address
# so the runtime container (connecting from the host over TCP) matches.
echo "host all all all scram-sha-256" >> "$PGDATA/pg_hba.conf"

# Bring the cluster up on the unix socket for the build steps.
step "starting postgres for build"
su postgres -c "pg_ctl -D $PGDATA -w -o '-c listen_addresses=' start"

run_sql() { su postgres -c "psql -v ON_ERROR_STOP=1 --username=$DB_USER --dbname=$1 -f $2"; }

# Set the role password so runtime TCP (scram) auth succeeds. Local socket is
# trust, so this psql needs no password itself.
step "set role password"
su postgres -c "psql -v ON_ERROR_STOP=1 --username=$DB_USER --dbname=postgres -c \"ALTER ROLE $DB_USER WITH PASSWORD '$DB_PASS';\""

su postgres -c "createdb --username=$DB_USER --owner=$DB_USER $DB_NAME"

# Apply migrations in journal order, then the generated seed.
for f in $(ls /work/migrations/*.sql | sort); do
  step "migration $(basename "$f")"
  run_sql "$DB_NAME" "$f"
done

# Seed load: parallel COPY, one independent chunk per park (see SPIKE-parallel-copy.md).
# Park subtrees never reference each other, so the chunks COPY concurrently with no
# join-up pass. Load sequence, all while the cluster is unlogged (WAL is the bottleneck
# that caps parallel COPY):
#   1. drop secondary indexes so COPY doesn't maintain them under concurrency
#   2. parallel COPY the chunks
#   3. rebuild the indexes in one bulk pass each (cheaper than incremental upkeep,
#      and the win grows with row/index count — see SPIKE-parallel-copy.md)
#   4. SET LOGGED — WAL-logs tables AND their fresh indexes together, once
# Sequence resets are global, so _finalize.sql runs once after all chunks.
JOBS="${SEED_LOAD_JOBS:-$(nproc)}"
SEED_TABLES="park pitch van reservation"

su postgres -c "psql -v ON_ERROR_STOP=1 --username=$DB_USER --dbname=$DB_NAME -c \
  'ALTER TABLE reservation SET UNLOGGED; ALTER TABLE van SET UNLOGGED; ALTER TABLE pitch SET UNLOGGED; ALTER TABLE park SET UNLOGGED;'"

# Capture the CREATE INDEX defs from the catalog (so this tracks the migrations with
# no hand-maintained DDL), then drop those indexes. Secondary = not primary-key and
# not backing a constraint (PKs / unique constraints stay — FKs depend on them).
step "capture + drop secondary indexes (bulk-rebuild after load)"
IDX_FILTER="i.indrelid = ANY (ARRAY['park','pitch','van','reservation']::regclass[]) AND NOT i.indisprimary AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)"
su postgres -c "psql -tAX -v ON_ERROR_STOP=1 --username=$DB_USER --dbname=$DB_NAME -c \
  \"SELECT pg_get_indexdef(i.indexrelid) || ';' FROM pg_index i WHERE $IDX_FILTER ORDER BY i.indexrelid::regclass::text;\"" \
  > /work/rebuild-indexes.sql
su postgres -c "psql -tAX -v ON_ERROR_STOP=1 --username=$DB_USER --dbname=$DB_NAME -c \
  \"SELECT 'DROP INDEX ' || i.indexrelid::regclass::text || ';' FROM pg_index i WHERE $IDX_FILTER;\"" \
  | su postgres -c "psql -v ON_ERROR_STOP=1 --username=$DB_USER --dbname=$DB_NAME"

step "seed load (parallel COPY, -P $JOBS, unlogged, index-free)"
# GNU xargs -P runs $JOBS psql processes concurrently, each COPYing one park chunk
# over the local socket. ON_ERROR_STOP + set -e means any chunk failure aborts the build.
ls /work/chunks/park-*.sql | xargs -P "$JOBS" -I {} \
  su postgres -c "psql -v ON_ERROR_STOP=1 --username=$DB_USER --dbname=$DB_NAME -f {}"

step "rebuild secondary indexes (bulk, still unlogged)"
run_sql "$DB_NAME" /work/rebuild-indexes.sql
rm -f /work/rebuild-indexes.sql

step "SET LOGGED (rewrites tables + indexes into WAL for a crash-safe image)"
su postgres -c "psql -v ON_ERROR_STOP=1 --username=$DB_USER --dbname=$DB_NAME -c \
  'ALTER TABLE park SET LOGGED; ALTER TABLE pitch SET LOGGED; ALTER TABLE van SET LOGGED; ALTER TABLE reservation SET LOGGED;'"

step "finalize (sequence resets)"
run_sql "$DB_NAME" /work/chunks/_finalize.sql

step "seed loaded — row counts:"
su postgres -c "psql --username=$DB_USER --dbname=$DB_NAME -c \
  \"SELECT 'park' t, count(*) FROM park UNION ALL SELECT 'pitch', count(*) FROM pitch UNION ALL SELECT 'van', count(*) FROM van UNION ALL SELECT 'reservation', count(*) FROM reservation;\""

step "VACUUM (FREEZE, ANALYZE)"
su postgres -c "psql -v ON_ERROR_STOP=1 --username=$DB_USER --dbname=$DB_NAME -c 'VACUUM (FREEZE, ANALYZE);'"

step "stopping postgres"
su postgres -c "pg_ctl -D $PGDATA -w stop"

step "bake complete"
