import { createClient } from '@/lib/supabase/server';
import { sendWhatsAppMessage } from './client';
import { generateRAGResponse } from '@/lib/ai/rag';
import { whatsappLogger } from '@/lib/utils/logger';
import { logSystemMessage } from '@/lib/whatsapp/history';

import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase-based message queue
 * Works across multiple instances
 */

export interface QueueJob {
    id: string;
    phone_number: string;
    message_text: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    retries: number;
    max_retries: number;
    error_message?: string;
    created_at: string;
}

/**
 * Add message to queue
 */
export async function enqueueMessage(phoneNumber: string, messageText: string, client?: SupabaseClient): Promise<string> {
    try {
        const supabase = client || await createClient();

        const { data, error } = await supabase
            .from('message_queue')
            .insert({
                phone_number: phoneNumber,
                message_text: messageText,
                status: 'pending'
            })
            .select('id')
            .single();

        if (error) throw error;

        whatsappLogger.info(`Message enqueued: ${data.id}`);
        return data.id;

    } catch (error) {
        whatsappLogger.error('Failed to enqueue message', error);
        throw error;
    }
}

/**
 * Process pending messages
 * Call this from a cron job or background worker
 */
export async function processQueue(client?: SupabaseClient): Promise<void> {
    try {
        // Use provided client, or create one with Service Role if available (for cron jobs), or fall back to standard createClient
        let supabase = client;
        if (!supabase) {
            if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
                const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');
                supabase = createSupabaseClient(
                    process.env.NEXT_PUBLIC_SUPABASE_URL!,
                    process.env.SUPABASE_SERVICE_ROLE_KEY
                );
            } else {
                supabase = await createClient();
            }
        }

        // Get pending messages (oldest first)
        const { data: jobs, error } = await supabase
            .from('message_queue')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(10); // Process 10 at a time

        if (error) throw error;
        if (!jobs || jobs.length === 0) return;

        whatsappLogger.info(`Processing ${jobs.length} messages from queue`);

        for (const job of jobs) {
            await processJob(job as QueueJob, supabase);
        }

    } catch (error) {
        whatsappLogger.error('Queue processing error', error);
    }
}

/**
 * Process a single job
 */
async function processJob(job: QueueJob, supabase: SupabaseClient): Promise<void> {
    try {
        // Mark as processing
        await supabase
            .from('message_queue')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', job.id);

        whatsappLogger.info(`Processing job ${job.id} from ${job.phone_number}`);

        // Fetch recent conversation history (last 30 messages). generateRAGResponse
        // keeps the last 12 verbatim and summarises anything older, so a deeper
        // fetch here gives long WhatsApp threads real memory without bloating
        // every prompt.
        const { data: historyData } = await supabase
            .from('whatsapp_messages')
            .select('role, content')
            .eq('phone_number', job.phone_number)
            .order('created_at', { ascending: false })
            .limit(30);

        // Reverse to get chronological order (oldest first)
        const history = (historyData || []).reverse().map(msg => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content
        }));

        // Generate AI response with conversation history
        const aiResponse = await generateRAGResponse(job.message_text, history, job.phone_number);

        // Send WhatsApp message
        // Pass the supabase client (which might have Service Role) to access settings
        const sendResult = await sendWhatsAppMessage(job.phone_number, aiResponse.message);

        // Store in chat history
        await supabase.from('whatsapp_chats').upsert({
            phone_number: job.phone_number,
            last_message: aiResponse.message,
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: 'phone_number' });

        await supabase.from('whatsapp_messages').insert({
            phone_number: job.phone_number,
            role: 'assistant',
            content: aiResponse.message,
            wa_message_id: sendResult.waMessageId,
            status: 'sent',
            status_updated_at: new Date().toISOString(),
        });

        // Mark as completed
        await supabase
            .from('message_queue')
            .update({
                status: 'completed',
                processed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', job.id);

        whatsappLogger.info(`Job ${job.id} completed successfully`);

    } catch (error) {
        whatsappLogger.error(`Job ${job.id} failed`, error);

        const newRetries = job.retries + 1;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        if (newRetries >= job.max_retries) {
            // Max retries reached - mark as failed
            await supabase
                .from('message_queue')
                .update({
                    status: 'failed',
                    retries: newRetries,
                    error_message: errorMessage,
                    processed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', job.id);

            whatsappLogger.error(`Job ${job.id} permanently failed after ${newRetries} retries`);
            await logSystemMessage(job.phone_number, `Error: Failed to process message after ${newRetries} retries. Reason: ${errorMessage}`);

            // Send fallback message
            try {
                await sendWhatsAppMessage(job.phone_number, 'Maaf, terjadi kesalahan saat memproses pesan Anda.');
            } catch (fallbackError) {
                whatsappLogger.error('Failed to send fallback message', fallbackError);
            }

        } else {
            // Retry - mark as pending again
            await supabase
                .from('message_queue')
                .update({
                    status: 'pending',
                    retries: newRetries,
                    error_message: errorMessage,
                    updated_at: new Date().toISOString()
                })
                .eq('id', job.id);

            whatsappLogger.info(`Job ${job.id} re-queued (retry ${newRetries}/${job.max_retries})`);
        }
    }
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
    try {
        const supabase = await createClient();

        const { data, error } = await supabase
            .from('message_queue')
            .select('status')
            .in('status', ['pending', 'processing']);

        if (error) throw error;

        const pending = data?.filter(j => j.status === 'pending').length || 0;
        const processing = data?.filter(j => j.status === 'processing').length || 0;

        return {
            pending,
            processing,
            total: pending + processing
        };

    } catch (error) {
        whatsappLogger.error('Failed to get queue stats', error);
        return { pending: 0, processing: 0, total: 0 };
    }
}
