/**
 * Simple in-memory message queue
 * For production with multiple instances, use Redis/BullMQ
 */

interface QueueJob {
    id: string;
    from: string;
    message: string;
    timestamp: number;
    retries: number;
}

type JobHandler = (job: QueueJob) => Promise<void>;

class MessageQueue {
    private queue: QueueJob[] = [];
    private processing = false;
    private handler: JobHandler | null = null;
    private maxRetries = 3;

    /**
     * Set the job handler function
     */
    setHandler(handler: JobHandler) {
        this.handler = handler;
    }

    /**
     * Add a job to the queue
     */
    async add(from: string, message: string): Promise<string> {
        const job: QueueJob = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            from,
            message,
            timestamp: Date.now(),
            retries: 0
        };

        this.queue.push(job);

        // Start processing if not already running
        if (!this.processing) {
            this.process();
        }

        return job.id;
    }

    /**
     * Process jobs in the queue
     */
    private async process() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        while (this.queue.length > 0) {
            const job = this.queue.shift();
            if (!job) break;

            try {
                if (this.handler) {
                    await this.handler(job);
                    console.log(`✅ Job ${job.id} completed`);
                }
            } catch (error) {
                console.error(`❌ Job ${job.id} failed:`, error);

                // Retry logic
                if (job.retries < this.maxRetries) {
                    job.retries++;
                    this.queue.push(job); // Re-queue
                    console.log(`🔄 Job ${job.id} re-queued (retry ${job.retries}/${this.maxRetries})`);
                } else {
                    console.error(`💀 Job ${job.id} failed permanently after ${this.maxRetries} retries`);
                }
            }
        }

        this.processing = false;
    }

    /**
     * Get queue stats
     */
    getStats() {
        return {
            queueLength: this.queue.length,
            processing: this.processing
        };
    }
}

// Export singleton instance
export const messageQueue = new MessageQueue();
