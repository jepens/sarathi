# Tiny self-hosted cron service for Easypanel.
#
# Purpose: hit Sarathi's queue drainer (/api/queue/process) once a minute so that
# retried and stranded WhatsApp jobs get processed even when no new message is
# arriving (the webhook only drains inline on inbound messages). This is the
# Easypanel-sanctioned "Dockerfile + crond" pattern — run it as a SEPARATE
# service in the same project, NOT baked into the Next.js app (whose CMD is
# `npm start`, so it can't also run crond).
#
# Configure via env on the Easypanel service:
#   TARGET_URL   e.g. https://nindra.sailendra.co.id/api/queue/process  (required)
#   CRON_SECRET  must match the app service's CRON_SECRET                (recommended)
#   SCHEDULE     cron expression, default "* * * * *" (every minute)     (optional)
#
# NOTE: Easypanel builds with the BUILD CONTEXT = repo root and only points
# `-f` at this Dockerfile, so the COPY below is written relative to repo root
# (deploy/cron/entrypoint.sh), NOT relative to this file's directory.
FROM alpine:3.20

RUN apk add --no-cache curl

COPY deploy/cron/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# crond runs in the foreground so the container stays alive and logs to stdout.
CMD ["/entrypoint.sh"]
