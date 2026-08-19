# Pinned to the prod major (18). Never `latest`: plan quality depends on the major.
FROM postgres:18

# Build inputs: migrations (Drizzle-generated) + the generated seed.
WORKDIR /work
COPY migrations/ /work/migrations/
COPY seed.sql /work/seed.sql
COPY docker/build-db.sh /work/build-db.sh

# Bake the dataset into a NON-VOLUME path so it survives into the image.
# (The postgres:18 VOLUME covers /var/lib/postgresql, so we bake to /var/lib/pgbaked.)
RUN chmod +x /work/build-db.sh && /work/build-db.sh && rm -rf /work/seed.sql

# Runtime: point the standard entrypoint at the baked cluster. It sees an
# initialised PGDATA and skips initdb, so start is instant. Listen on TCP.
ENV PGDATA=/var/lib/pgbaked
EXPOSE 5432
CMD ["postgres", "-c", "listen_addresses=*"]
