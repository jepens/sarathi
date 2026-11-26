# VPS Deployment Guide - Nixpacks

**Project**: Sahabat UMKM  
**Platform**: VPS (Coolify/similar)  
**Build Method**: Nixpacks  
**Date**: 2025-11-28

---

## 🎯 Why Nixpacks?

✅ **Auto-detect Next.js** - No configuration needed  
✅ **Modern & Maintained** - Actively developed by Railway  
✅ **Zero Docker Knowledge** - Just works!  
✅ **Optimal for Next.js 14+** - Best practices built-in  
✅ **Fast Builds** - Efficient caching

---

## 📋 Pre-Deployment Checklist

### 1. Database Setup
- [ ] Verify tables created: `message_queue`, `rate_limits`, `whatsapp_chats`, `whatsapp_messages`
- [ ] Test connection from local
- [ ] **Apply ALL pending `supabase/migrations/*.sql` BEFORE deploying app code** (see ⚠️ below)

> ⚠️ **Migrations must run before the app code that reads them.** Migrations are
> applied **manually** (Supabase MCP `apply_migration`, the CLI, or the SQL
> Editor) and **CI never touches the database** — so deploying app code first
> makes any SELECT of a not-yet-added column return **500**.
>
> Most recent: [`supabase/migrations/0044_whatsapp_chats_portal_client.sql`](../supabase/migrations/0044_whatsapp_chats_portal_client.sql)
> adds `whatsapp_chats.portal_client_id` (uuid) + `portal_last_proposal_url`
> (text) for the Portal handoff. If the app ships before it runs, `GET /api/leads`
> 500s and the **entire leads/pipeline board renders empty** (not just the handoff
> feature). Columns are additive + idempotent (`add column if not exists`), so
> applying them early is always safe.
>
> **Order:** apply migration → verify the columns exist → *then* deploy app code.

### 2. Code Preparation
- [ ] All changes committed to Git
- [ ] Webhook route switched to scalable version
- [ ] Build passes locally (`npm run build`)
- [ ] `.env.example` updated

### 3. GitHub Repository
- [ ] Code pushed to GitHub
- [ ] Repository is accessible
- [ ] Branch name noted (usually `main`)

---

## 🚀 Deployment Steps

### Step 1: Connect GitHub Repository

1. In VPS Dashboard, click **Deploy**
2. Select **Source** → **Github**
3. Fill in:
   - **Owner**: Your GitHub username
   - **Repository**: `sahabat-umkm` (or your repo name)
   - **Branch**: `main`
   - **Build Path**: `/` (leave default)

### Step 2: Select Build Method

1. Scroll to **Build** section
2. Select **Nixpacks** ✅
3. Click **Save**

**Why not others?**
- ❌ Dockerfile - Requires manual maintenance
- ❌ Buildpacks - Older, slower
- ✅ Nixpacks - Auto-detect, modern, fast

### Step 3: Configure Environment Variables

Add these in VPS Environment Settings:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# OpenAI
OPENAI_API_KEY=sk-your-key

# WhatsApp: no credentials here. Each org's app secret and token live in
# Supabase Vault (docs/WHATSAPP_SETUP.md); only these two optional switches
# are env (see .env.example).
# WHATSAPP_OTHER_NUMBER_EVENTS=
# WHATSAPP_DEBOUNCE_SECONDS=

# Production (Optional but Recommended)
CRON_SECRET=your-random-secret
NODE_ENV=production
```

**How to get values:**
- Supabase: Dashboard → Settings → API
- OpenAI: https://platform.openai.com/api-keys
- WhatsApp: provisioned into Vault with `scripts/wa-provision.mjs` (docs/WHATSAPP_SETUP.md)
- CRON_SECRET: Generate random string (e.g., `openssl rand -hex 32`)

### Step 4: Deploy!

1. Click **Deploy** button
2. Wait for build to complete (~2-3 minutes)
3. Check logs for errors
4. Note your deployment URL

**What Nixpacks does automatically:**
```bash
# 1. Detect Next.js
# 2. Install dependencies
npm install

# 3. Build production
npm run build

# 4. Start server
npm start
```

---

## ⏰ Cron Job Setup (Queue Processing)

Since VPS doesn't have built-in cron like Vercel, you need to set it up manually.

### Option 1: Linux Crontab (Recommended)

SSH to your VPS:

```bash
ssh user@your-vps-ip
```

Edit crontab:

```bash
crontab -e
```

Add this line:

```bash
# Process WhatsApp queue every minute
* * * * * curl -X GET https://your-domain.com/api/queue/process -H "Authorization: Bearer YOUR_CRON_SECRET" >> /var/log/whatsapp-queue.log 2>&1
```

**Replace:**
- `your-domain.com` → Your actual domain
- `YOUR_CRON_SECRET` → Value from environment variables

**Verify cron is running:**

```bash
# Check crontab
crontab -l

# Check logs
tail -f /var/log/whatsapp-queue.log
```

### Option 2: GitHub Actions

Create `.github/workflows/process-queue.yml`:

```yaml
name: Process WhatsApp Queue

on:
  schedule:
    - cron: '* * * * *'  # Every minute
  workflow_dispatch:      # Manual trigger

jobs:
  process:
    runs-on: ubuntu-latest
    steps:
      - name: Process Queue
        run: |
          curl -X GET https://your-domain.com/api/queue/process \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

**Setup:**
1. Add `CRON_SECRET` to GitHub Secrets
2. Commit workflow file
3. GitHub will run it every minute

### Option 3: External Cron Service

Use free services:
- **cron-job.org** (free, reliable)
- **EasyCron** (free tier available)

**Configuration:**
- URL: `https://your-domain.com/api/queue/process`
- Method: GET
- Headers: `Authorization: Bearer YOUR_CRON_SECRET`
- Frequency: Every 1 minute

---

## 🔧 Post-Deployment Configuration

### 1. Update WhatsApp Webhook

1. Go to Meta for Developers
2. Navigate to: Your App → WhatsApp → Configuration
3. Click **Edit** on Webhook
4. Enter:
   - **Callback URL**: `https://your-domain.com/api/webhook/whatsapp/<webhook_key>` (printed by `scripts/wa-provision.mjs --phase=app`)
   - **Verify Token**: the token the same phase printed (shown once)
5. Click **Verify and Save**
6. Subscribe to **messages** field

### 2. Test the Integration

```bash
# Test webhook verification
curl "https://your-domain.com/api/webhook/whatsapp/<webhook_key>?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test123"

# Should return: test123
```

### 3. Send Test WhatsApp Message

Send a message from your WhatsApp to the business number.

**Check:**
1. Message appears in `message_queue` table (Supabase)
2. After 1 minute, status changes to `completed`
3. You receive AI response in WhatsApp

---

## 📊 Monitoring

### Check Application Logs

In VPS dashboard, view logs for:
- Build errors
- Runtime errors
- WhatsApp webhook calls

### Check Queue Status

```sql
-- In Supabase SQL Editor
SELECT status, COUNT(*) 
FROM message_queue 
GROUP BY status;
```

### Check Cron Logs

```bash
# SSH to VPS
tail -f /var/log/whatsapp-queue.log
```

---

## 🐛 Troubleshooting

### Build Fails

**Check:**
- All dependencies in `package.json`
- TypeScript errors (`npm run build` locally)
- Environment variables set correctly

**Common fixes:**
```bash
# Clear cache and rebuild
rm -rf .next node_modules
npm install
npm run build
```

### Webhook Not Receiving Messages

**Check:**
1. Webhook URL is correct in Meta Dashboard
2. HTTPS is enabled (required by Meta)
3. Verify token matches
4. Check VPS logs for incoming requests

### Queue Not Processing

**Check:**
1. Cron job is running (`crontab -l`)
2. CRON_SECRET matches
3. `/api/queue/process` endpoint is accessible
4. Check cron logs for errors

### Rate Limiting Not Working

**Check:**
1. Database migration ran successfully
2. `rate_limits` table exists
3. Supabase connection is working

---

## 🔄 Updates & Redeployment

### To Deploy Updates:

```bash
# 1. Make changes locally
# 2. Test locally
npm run build

# 3. Commit and push
git add .
git commit -m "Update feature X"
git push origin main

# 4. VPS auto-deploys (if auto-deploy enabled)
# Or manually trigger deploy in VPS dashboard
```

---

## 📈 Scaling Considerations

### Current Setup Handles:
- **~600 messages/hour** (1-min cron)
- **Multiple instances** (database-based state)
- **Unlimited users** (with rate limiting)

### To Scale Further:

1. **Increase Cron Frequency**
   ```bash
   # Every 30 seconds
   */30 * * * * curl ...
   ```

2. **Increase Batch Size**
   Edit `lib/whatsapp/queue-db.ts`:
   ```typescript
   .limit(20) // Process 20 at a time instead of 10
   ```

3. **Add More Instances**
   Just deploy more instances - they all share the same queue!

---

## ✅ Deployment Checklist

- [ ] **All pending `supabase/migrations/*.sql` applied & columns verified — BEFORE deploying app code**
- [ ] Database migration completed
- [ ] Code pushed to GitHub
- [ ] VPS connected to GitHub repo
- [ ] Nixpacks selected as build method
- [ ] All environment variables set
- [ ] Deployment successful
- [ ] Cron job configured
- [ ] WhatsApp webhook updated
- [ ] Test message sent and received
- [ ] Monitoring setup

---

## 🎊 Success!

Your Sahabat UMKM is now:
- ✅ Deployed to production VPS
- ✅ Horizontally scalable
- ✅ Processing messages via queue
- ✅ Rate limiting users
- ✅ Secure with signature verification
- ✅ Monitored with structured logging

**Ready to serve thousands of users!** 🚀

---

**Need Help?**
- Check VPS logs
- Review Supabase tables
- Test with ngrok first
- Consult documentation in `docs/`
