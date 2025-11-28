# Multi-Instance Scalability Guide

**Date**: 2025-11-28  
**Status**: ✅ Implemented

This guide explains how to scale Sahabat UMKM to multiple instances using **Supabase as shared state**.

---

## 🎯 Overview

### Problem with In-Memory Solutions
- ❌ Rate limiting only works on single instance
- ❌ Message queue doesn't work across instances
- ❌ Each instance has its own state

### Solution: Supabase-based State
- ✅ Rate limiting shared across all instances
- ✅ Message queue accessible by all instances
- ✅ No Redis or external service needed
- ✅ Simple to implement and maintain

---

## 🏗️ Architecture

```
Instance 1 ─┐
Instance 2 ─┼─→ Supabase PostgreSQL ←─ Cron Worker
Instance 3 ─┘      (Shared State)
```

**Components**:
1. **Webhook Instances** - Receive messages, check rate limit, enqueue
2. **Supabase Database** - Stores queue and rate limit data
3. **Cron Worker** - Processes queue every minute

---

## 📦 What Was Implemented

### 1. Database Schema
**File**: `database/scalability-schema.sql`

Two new tables:
- `message_queue` - Stores pending messages
- `rate_limits` - Tracks request counts

### 2. Database-based Rate Limiter
**File**: `lib/whatsapp/rate-limiter-db.ts`

```typescript
import { checkRateLimit } from '@/lib/whatsapp/rate-limiter-db';

const allowed = await checkRateLimit(phoneNumber);
if (!allowed) {
    // Rate limited
}
```

### 3. Database-based Message Queue
**File**: `lib/whatsapp/queue-db.ts`

```typescript
import { enqueueMessage, processQueue } from '@/lib/whatsapp/queue-db';

// Add to queue
await enqueueMessage(phoneNumber, messageText);

// Process queue (called by cron)
await processQueue();
```

### 4. Queue Worker API
**File**: `app/api/queue/process/route.ts`

Endpoint for cron job to process queue.

### 5. Updated Webhook
**File**: `app/api/webhook/whatsapp/route-scalable.ts`

Uses database-based rate limiter and queue.

### 6. Vercel Cron Config
**File**: `vercel.json`

Runs queue processor every minute.

---

## 🚀 Setup Instructions

### Step 1: Run Database Migration

Execute the SQL schema in Supabase:

1. Go to Supabase Dashboard → SQL Editor
2. Copy content from `database/scalability-schema.sql`
3. Run the SQL
4. Verify tables created:
   - `message_queue`
   - `rate_limits`

### Step 2: Replace Webhook Route

**Option A: Rename files**
```bash
# Backup old webhook
mv app/api/webhook/whatsapp/route.ts app/api/webhook/whatsapp/route-old.ts

# Use scalable version
mv app/api/webhook/whatsapp/route-scalable.ts app/api/webhook/whatsapp/route.ts
```

**Option B: Copy content**
Copy content from `route-scalable.ts` to `route.ts`

### Step 3: Deploy to Vercel

```bash
vercel deploy --prod
```

Vercel will automatically:
- Read `vercel.json`
- Set up cron job
- Call `/api/queue/process` every minute

### Step 4: Optional - Add Cron Secret

For security, add to `.env` in Vercel:
```env
CRON_SECRET=your-random-secret-string
```

Then update cron configuration in Vercel Dashboard to include:
```
Authorization: Bearer your-random-secret-string
```

---

## 🔧 How It Works

### Message Flow

1. **User sends WhatsApp message**
2. **Meta calls webhook** (any instance)
3. **Webhook checks rate limit** (Supabase query)
4. **Webhook adds to queue** (Supabase insert)
5. **Returns 200 OK** (immediate response)
6. **Cron runs every minute** (Vercel Cron)
7. **Cron calls `/api/queue/process`**
8. **Queue processor**:
   - Fetches pending messages
   - Generates AI responses
   - Sends WhatsApp replies
   - Marks as completed

### Rate Limiting

```sql
-- Check if user exceeded limit
SELECT * FROM rate_limits WHERE identifier = '628123456789';

-- If within window and count < 10: increment
UPDATE rate_limits SET request_count = request_count + 1;

-- If window expired: reset
UPDATE rate_limits SET request_count = 1, window_start = NOW();
```

### Queue Processing

```sql
-- Get pending messages
SELECT * FROM message_queue 
WHERE status = 'pending' 
ORDER BY created_at ASC 
LIMIT 10;

-- Process each message
UPDATE message_queue SET status = 'processing';
-- ... AI processing ...
UPDATE message_queue SET status = 'completed';
```

---

## 📊 Performance Considerations

### Database Load
- **Rate Limit Check**: 1 query per message
- **Queue Insert**: 1 query per message
- **Queue Processing**: ~10 queries per minute

**Total**: Very light load for Supabase

### Cron Frequency
- **Default**: Every minute
- **Adjustable**: Can run every 30s or 2 minutes

### Scaling Limits
- **Instances**: Unlimited (Supabase handles concurrency)
- **Messages**: ~600/hour with 1-minute cron
- **Can scale to**: 10,000+ messages/hour with optimization

---

## 🧹 Maintenance

### Cleanup Old Data

Run periodically (weekly):

```sql
-- Cleanup old rate limits (older than 5 minutes)
SELECT cleanup_old_rate_limits();

-- Cleanup old queue entries (completed/failed older than 24 hours)
SELECT cleanup_old_queue_entries();
```

**Option**: Set up Supabase cron job for automatic cleanup.

---

## 🔍 Monitoring

### Check Queue Status

```typescript
import { getQueueStats } from '@/lib/whatsapp/queue-db';

const stats = await getQueueStats();
// { pending: 5, processing: 2, total: 7 }
```

### View Queue in Database

```sql
-- Pending messages
SELECT * FROM message_queue WHERE status = 'pending';

-- Failed messages
SELECT * FROM message_queue WHERE status = 'failed';

-- Processing time
SELECT 
    AVG(EXTRACT(EPOCH FROM (processed_at - created_at))) as avg_seconds
FROM message_queue 
WHERE status = 'completed';
```

---

## 🆚 Comparison: In-Memory vs Database

| Feature | In-Memory | Database (Supabase) |
|---------|-----------|---------------------|
| Multi-instance | ❌ No | ✅ Yes |
| Persistence | ❌ Lost on restart | ✅ Persistent |
| Monitoring | ❌ Limited | ✅ Full visibility |
| Complexity | ✅ Simple | ✅ Still simple |
| External deps | ✅ None | ✅ Supabase (already have) |
| Cost | ✅ Free | ✅ Free (Supabase free tier) |

---

## 🎯 Migration Path

### From In-Memory to Database

**Step 1**: Run database migration  
**Step 2**: Replace webhook route  
**Step 3**: Deploy  
**Step 4**: Test  

**Rollback**: Just revert to old `route.ts`

---

## 🚀 Deployment Platforms

### Vercel (Recommended)
- ✅ Built-in cron support
- ✅ Auto-scaling
- ✅ Free tier available

### Railway
- ✅ Supports cron (via separate service)
- ✅ Auto-scaling

### Other Platforms
Use external cron service:
- **GitHub Actions** (cron schedule)
- **Cron-job.org** (free)
- **EasyCron** (free tier)

Example GitHub Actions:
```yaml
name: Process Queue
on:
  schedule:
    - cron: '* * * * *'  # Every minute
jobs:
  process:
    runs-on: ubuntu-latest
    steps:
      - name: Call queue processor
        run: |
          curl -X GET https://your-app.com/api/queue/process \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

---

## ✅ Testing

### Test Rate Limiting

Send 11 messages rapidly from same number:
- First 10 should be queued
- 11th should be rate limited

### Test Queue Processing

1. Send a message
2. Check database: `SELECT * FROM message_queue;`
3. Wait 1 minute (cron runs)
4. Check again - status should be 'completed'

### Test Multi-Instance

Deploy to Vercel (auto-scales):
- Send messages from multiple users
- All should be processed correctly
- No duplicate processing

---

## 🎊 Summary

You now have a **production-ready, multi-instance scalable** WhatsApp integration using:

- ✅ Supabase for shared state (no Redis needed)
- ✅ Database-based rate limiting
- ✅ Database-based message queue
- ✅ Cron-based queue processing
- ✅ Simple to deploy and maintain

**Ready to scale to thousands of users!** 🚀

---

**Questions?** Check the code comments or Supabase documentation.
