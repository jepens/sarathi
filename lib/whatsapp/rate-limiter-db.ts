import { createClient } from '@/lib/supabase/server';

/**
 * Supabase-based rate limiter
 * Works across multiple instances
 */

const MAX_REQUESTS = 10;
const WINDOW_MS = 60000; // 1 minute

export async function checkRateLimit(identifier: string): Promise<boolean> {
    try {
        const supabase = await createClient();

        // Try to get existing rate limit entry
        const { data: existing, error: fetchError } = await supabase
            .from('rate_limits')
            .select('*')
            .eq('identifier', identifier)
            .single();

        if (fetchError && fetchError.code !== 'PGRST116') {
            // PGRST116 = not found, which is OK
            console.error('Error fetching rate limit:', fetchError);
            return true; // Allow on error (fail open)
        }

        const now = new Date();

        if (!existing) {
            // First request - create entry
            await supabase.from('rate_limits').insert({
                identifier,
                request_count: 1,
                window_start: now.toISOString()
            });
            return true;
        }

        const windowStart = new Date(existing.window_start);
        const windowAge = now.getTime() - windowStart.getTime();

        if (windowAge > WINDOW_MS) {
            // Window expired - reset
            await supabase
                .from('rate_limits')
                .update({
                    request_count: 1,
                    window_start: now.toISOString(),
                    updated_at: now.toISOString()
                })
                .eq('identifier', identifier);
            return true;
        }

        if (existing.request_count >= MAX_REQUESTS) {
            // Rate limited
            return false;
        }

        // Increment counter
        await supabase
            .from('rate_limits')
            .update({
                request_count: existing.request_count + 1,
                updated_at: now.toISOString()
            })
            .eq('identifier', identifier);

        return true;

    } catch (error) {
        console.error('Rate limit check error:', error);
        return true; // Fail open - allow on error
    }
}

/**
 * Get remaining requests for identifier
 */
export async function getRemainingRequests(identifier: string): Promise<number> {
    try {
        const supabase = await createClient();

        const { data } = await supabase
            .from('rate_limits')
            .select('request_count, window_start')
            .eq('identifier', identifier)
            .single();

        if (!data) return MAX_REQUESTS;

        const windowAge = Date.now() - new Date(data.window_start).getTime();
        if (windowAge > WINDOW_MS) return MAX_REQUESTS;

        return Math.max(0, MAX_REQUESTS - data.request_count);

    } catch {
        return MAX_REQUESTS;
    }
}
