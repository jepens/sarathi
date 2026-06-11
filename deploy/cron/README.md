# Queue drainer cron (Easypanel)

A standalone one-minute pinger for `POST`-less `GET /api/queue/process`. The
WhatsApp webhook drains the queue inline on each inbound message, but **retried**
jobs and jobs **stranded in `processing`** (worker restart) need a periodic kick.
On Vercel that was `vercel.json` crons; on our VPS/Easypanel those are inactive,
so we run this tiny service instead.

## Set up in Easypanel (one time)

1. **Set `CRON_SECRET`** on the **app** service (Environment tab), e.g. a long
   random string, and redeploy. This locks down `/api/queue/process` so only
   callers with the secret can trigger it.
2. **Create a new service** in the same project → type **App** → source **Git**
   (this repo, same branch as the app), and set:
   - **Build**: Builder = **Dockerfile**, Dockerfile path = `deploy/cron/Dockerfile`
     (build context stays at the repo root — the Dockerfile's `COPY` is written
     relative to root, so don't change the context)
   - **Environment**:
     - `TARGET_URL=https://nindra.sailendra.co.id/api/queue/process`
     - `CRON_SECRET=<same value as the app service>`
     - `SCHEDULE=* * * * *`  *(optional; default is every minute)*
   - No domain / no published port needed — it only makes outbound calls.
3. Deploy. Watch its **Logs**: you should see `[cron] scheduled '* * * * *'` then a
   line per minute. A healthy run logs the JSON `{"success":true,...}`.

## Why a separate service

The app container's `CMD` is `npm start`, so it can't also run `crond`. Easypanel
has no native "scheduled task" button — its docs recommend either a Dockerfile +
`crond` service (this) or an external scheduler (e.g. cron-job.org) hitting the
same URL with the `Authorization: Bearer <CRON_SECRET>` header.
