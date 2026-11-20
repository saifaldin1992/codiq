# 24-ج (ق-147) — the image the six-hourly database dump runs in.
#
# WHY A DOCKERFILE AT ALL, when every other service in this project builds with
# Railpack and no image definition. Because this service needs ONE thing the
# builder cannot give it: `pg_dump` from PostgreSQL 18.
#
# Neon runs PostgreSQL 18, and `pg_dump` REFUSES a server newer than itself —
# `backup-database.ts` checks the client major before it dumps and stops rather
# than produce a partial file (see the header there). Debian bookworm ships
# postgresql-client 15, so `apt-get install postgresql-client` yields a binary
# that cannot read this database at all. The PGDG repository is where 18 lives,
# and adding a third-party apt source is exactly the kind of thing that belongs
# in a file under review rather than in a dashboard field nobody can diff.
#
# The DR doc used to say «with nixpacks add postgresql_18 to the build packages».
# That was written before the services moved to Railpack, and it described a
# setting that does not exist here — the drift was found while building this.
#
# Scoped to this service alone: the API image stays exactly as it is, and does
# not grow a database client it never calls.
FROM node:22-bookworm-slim

# PGDG, by the procedure postgresql.org publishes: fetch the signing key to its
# own file and reference it from the source line with signed-by, rather than the
# deprecated apt-key. `--no-install-recommends` keeps the image from pulling a
# full server alongside the client.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && rm -rf /var/lib/apt/lists/*

# Fail the BUILD, not the 03:00 run, if the client is not the major this database
# needs. A dump job that discovers its own image is wrong at runtime discovers it
# in a log nobody reads.
RUN pg_dump --version && test "$(pg_dump --version | grep -oE '[0-9]+' | head -1)" -ge 18

WORKDIR /app
RUN corepack enable

# Dependencies first, so a change to source does not re-resolve the whole tree.
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

COPY . .

# No HTTP server, no port, no healthcheck: Railway runs this on a cron schedule
# and the process is expected to exit. `backup:run` reads its key BEFORE it
# dumps, so a misconfigured deployment costs one second and touches nothing.
CMD ["pnpm", "backup:run"]
