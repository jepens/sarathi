import { NextResponse } from 'next/server';
import { processQueue } from '@/lib/whatsapp/queue-db';
import { whatsappLogger } from '@/lib/utils/logger';

/**
 * Queue worker endpoint
 * Call this from a cron job (e.g., Vercel Cron, GitHub Actions)
 * 
 * Example cron: Every minute
 * curl https://your-app.com/api/queue/process
 */

export async function GET(request: Request) {
    try {
        // Optional: Add authentication
        const authHeader = request.headers.get('authorization');
        const cronSecret = process.env.CRON_SECRET;

        if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
            whatsappLogger.warn('Unauthorized queue process attempt');
            return new NextResponse('Unauthorized', { status: 401 });
        }

        whatsappLogger.info('Queue processing started');

        await processQueue();

        whatsappLogger.info('Queue processing completed');

        return NextResponse.json({ success: true, message: 'Queue processed' });

    } catch (error) {
        whatsappLogger.error('Queue processing failed', error);
        return NextResponse.json(
            { success: false, error: 'Queue processing failed' },
            { status: 500 }
        );
    }
}
