#!/bin/sh
# `config.js` reads one `DATABASE_URL`, but the password has to arrive as a secret of its own:
# ECS injects secrets one environment variable at a time (`secrets:` in the task definition),
# and putting the assembled URL in the task definition would print the password into every
# `DescribeTaskDefinition` reply. So the URL is composed here, at start, from the plain
# endpoint variables plus the injected password, and nothing else in the stack ever holds it.
#
# The generated password is alphanumeric — `DbSecret` in cloudformation.yml sets
# `ExcludePunctuation: true` — so nothing in it needs percent-encoding and no escaping happens
# here. If that ever changes, this line has to escape instead.
set -e

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT:-5432}/${DB_NAME}"
  # RDS rejects an unencrypted connection outright ("no pg_hba.conf entry ... no encryption"),
  # so TLS is not optional here. `verify-full` rather than `require` because `pg` will one day
  # follow libpq, where `require` stops checking the certificate at all: name the guarantee.
  # `DB_SSL=off` is the escape hatch for a plain Postgres that speaks no TLS.
  if [ "${DB_SSL:-on}" != "off" ] && [ -f "${DB_CA:-/app/rds-ca.pem}" ]; then
    DATABASE_URL="${DATABASE_URL}?sslmode=verify-full&sslrootcert=${DB_CA:-/app/rds-ca.pem}"
  fi
  export DATABASE_URL
fi

# Fail loudly rather than silently falling back to the localhost defaults in `config.js`:
# a task that boots against 127.0.0.1 would exit on `pgAvailable()` with a message naming a
# host nobody deployed, and the useful fact (the variable never arrived) would be lost.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] no DATABASE_URL and no DB_HOST — refusing to start" >&2
  exit 78   # EX_CONFIG
fi
if [ -z "${REDIS_URL:-}" ]; then
  echo "[entrypoint] no REDIS_URL — refusing to start (the in-process fallback is a dev mode)" >&2
  exit 78
fi

exec "$@"
