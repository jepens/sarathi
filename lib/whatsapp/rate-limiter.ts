/**
 * Simple in-memory rate limiter
 * Good for single-instance deployments
 * For multi-instance, use Redis
 */

interface RateLimitEntry {
    count: number;
    resetTime: number;
}

class RateLimiter {
    private requests: Map<string, RateLimitEntry> = new Map();
    private maxRequests: number;
    private windowMs: number;

    constructor(maxRequests: number = 10, windowMs: number = 60000) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;

        // Cleanup old entries every minute
        setInterval(() => this.cleanup(), 60000);
    }

    /**
     * Check if request is allowed
     * @param identifier - Unique identifier (e.g., phone number, IP)
     * @returns boolean - true if allowed, false if rate limited
     */
    check(identifier: string): boolean {
        const now = Date.now();
        const entry = this.requests.get(identifier);

        if (!entry || now > entry.resetTime) {
            // New window
            this.requests.set(identifier, {
                count: 1,
                resetTime: now + this.windowMs
            });
            return true;
        }

        if (entry.count >= this.maxRequests) {
            // Rate limited
            return false;
        }

        // Increment count
        entry.count++;
        return true;
    }

    /**
     * Get remaining requests for identifier
     */
    getRemaining(identifier: string): number {
        const entry = this.requests.get(identifier);
        if (!entry || Date.now() > entry.resetTime) {
            return this.maxRequests;
        }
        return Math.max(0, this.maxRequests - entry.count);
    }

    /**
     * Cleanup expired entries
     */
    private cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.requests.entries()) {
            if (now > entry.resetTime) {
                this.requests.delete(key);
            }
        }
    }
}

// Export singleton instance
// 10 messages per minute per phone number
export const whatsappRateLimiter = new RateLimiter(10, 60000);
