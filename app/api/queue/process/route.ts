import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { processQueue } from '@/lib/whatsapp/queue-db';
import { maybeSendFollowupDigest } from '@/lib/followup/digest';
import { whatsappLogger } from '@/lib/utils/logger';
import { maybeSendOpsAlerts, maybeSendOpsDailySummary } from '@/lib/ops/alerts';

/**
 * Queue worker endpoint
 * Call this from a cron job (e.g., Vercel Cron, GitHub Actions)
 * 
 * Example cron: Every minute
 * curl https://your-app.com/api/queue/process
 */

export async function GET(request: Request) {
    try {
        const authHeader = request.headers.get('authorization');
        const cronSecret = process.env.CRON_SECRET;

        // This endpoint drains the queue (sends WhatsApp replies) and triggers
        // the follow-up digest, so it must be authenticated in production. When
        // CRON_SECRET is unset it would be OPEN to anyone — refuse rather than
        // run unprotected. Local dev stays frictionless (no secret required).
        if (!cronSecret) {
            if (process.env.NODE_ENV === 'production') {
                whatsappLogger.error('CRON_SECRET is not set in production — refusing to run the unauthenticated queue endpoint');
                return new NextResponse('Server misconfigured: CRON_SECRET required', { status: 503 });
            }
        } else if (authHeader !== `Bearer ${cronSecret}`) {
            whatsappLogger.warn('Unauthorized queue process attempt');
            return new NextResponse('Unauthorized', { status: 401 });
        }

        whatsappLogger.info('Queue processing started');

        // Initialize Supabase client with Service Role Key
        // This ensures the queue processor can access settings (which are RLS protected)
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );

        await processQueue(supabase);

        whatsappLogger.info('Queue processing completed');

        // Piggyback the daily follow-up digest on this every-minute cron. It
        // self-guards (sends at most once/day after the configured hour) and is
        // a no-op unless FOLLOWUP_DIGEST_TO is set. Never let it break the queue.
        try {
            await maybeSendFollowupDigest(supabase);
        } catch (digestError) {
            whatsappLogger.error('Follow-up digest check failed', digestError);
        }

        // Team alerts (tracker 3.5): first turn queue jobs the database itself
        // gave up on into events, then at most one email per kind and org per
        // hour, and the daily summary. Never let it break the queue.
        try {
            const { data: staleJobs } = await supabase.rpc('report_stale_queue_failures');
            if (staleJobs) whatsappLogger.warn(`Queue jobs failed by the stale-job reclaim: ${staleJobs}`);
            const alert = await maybeSendOpsAlerts(supabase);
            if (alert.sent) whatsappLogger.info(`Ops alert emailed: ${alert.kinds.join(', ')}`);
            const daily = await maybeSendOpsDailySummary(supabase);
            if (daily.sent) whatsappLogger.info('Ops daily summary emailed');
        } catch (alertError) {
            whatsappLogger.error('Ops alert check failed', alertError);
        }

        // Prune old completed/failed queue rows (and stale rate-limit rows) so
        // the table and the wamid idempotency indexes don't grow unbounded.
        // Guarded to ~once/hour (this endpoint runs every minute); never let it
        // break the queue. Retention is 24h, safely beyond Meta's redelivery
        // horizon, so pruning can't reopen the dedup window.
        if (new Date().getMinutes() === 0) {
            try {
                await supabase.rpc('cleanup_old_queue_entries');
                await supabase.rpc('cleanup_old_rate_limits');
                await supabase.rpc('cleanup_old_ops_events');
                whatsappLogger.info('Hourly queue/rate-limit cleanup done');
            } catch (cleanupError) {
                whatsappLogger.error('Queue cleanup failed', cleanupError);
            }
        }

        return NextResponse.json({ success: true, message: 'Queue processed' });

    } catch (error) {
        whatsappLogger.error('Queue processing failed', error);
        return NextResponse.json(
            { success: false, error: 'Queue processing failed' },
            { status: 500 }
        );
    }
}
