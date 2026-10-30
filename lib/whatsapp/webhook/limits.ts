// The limits of the webhook pipeline (Fase 2 task 2.2a part 2). A plain module
// of constants, so a test that mocks another module (the quota, the queue)
// cannot hide one of them.

/** Messages per contact and 60 s window before the rest is refused (as part 1). */
export const RATE_LIMIT_PER_MINUTE = 10;

/**
 * A text that reaches us this many hours after the customer sent it (Meta's
 * time) gets no AI reply (owner decision D23-2): a free-form reply past 24 h
 * fails at Meta anyway (131047), and a 20 h old question rarely wants an
 * automatic answer.
 */
export const AI_MAX_AGE_HOURS = 20;

/** Time a delivery may take before the rest of its items is deferred (503). */
export const BUDGET_MS = 8000;

/** Failures of one item in this process before it is stored as a placeholder. */
export const POISON_LIMIT = 5;

/** Consecutive retryable failures after which the rest of a batch is deferred. */
export const STOP_AFTER_RETRYABLE = 3;

/**
 * Message keys per pre-dedup query: a GET whose URL lists them, which stays
 * well under the 8 KB a gateway usually accepts (a wamid is ~60-90 chars).
 */
export const PREDEDUP_CHUNK = 50;

/** Delay before a status that found no message row is applied once more. */
export const STATUS_REAPPLY_MS = 15000;

/** Only a status this young (Meta time) is applied once more. */
export const STATUS_REAPPLY_MAX_AGE_MS = 120000;
