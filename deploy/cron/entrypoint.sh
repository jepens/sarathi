#!/bin/sh
# Build the crontab at container start so it captures the env vars Easypanel
# injects (crond itself runs with a bare environment, so we bake the values into
# the command line here rather than relying on the daemon's env).
set -eu

: "${TARGET_URL:?TARGET_URL is required (e.g. https://nindra.sailendra.co.id/api/queue/process)}"
SCHEDULE="${SCHEDULE:-* * * * *}"

# -f fail on HTTP errors, -s silent, -S still show errors, -m 30 cap each run.
# Send the Bearer header only when CRON_SECRET is set (the endpoint accepts both,
# but production should set it). Output goes to PID 1's stdout = container logs.
if [ -n "${CRON_SECRET:-}" ]; then
    CMD="curl -fsS -m 30 -H \"Authorization: Bearer ${CRON_SECRET}\" \"${TARGET_URL}\""
else
    CMD="curl -fsS -m 30 \"${TARGET_URL}\""
fi

echo "${SCHEDULE} ${CMD} >/proc/1/fd/1 2>&1" > /etc/crontabs/root

echo "[cron] scheduled '${SCHEDULE}' -> ${TARGET_URL}"
exec crond -f -l 8
