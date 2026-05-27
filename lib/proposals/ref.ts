import { randomBytes } from 'node:crypto';

// Single source of truth for proposal reference numbers.
// Format: SLDR-{YYYYMMDD}-{last4 of phone}-{4 hex chars}
//
// The trailing random suffix is what makes refs unique even when the same
// admin sends multiple proposals to the same lead on the same day (e.g.
// initial draft + revision after client feedback). Without it, the daily
// component collides immediately.

export function generateProposalRef(phone: string, when: Date = new Date()): string {
    const y = when.getFullYear();
    const m = (when.getMonth() + 1).toString().padStart(2, '0');
    const d = when.getDate().toString().padStart(2, '0');
    const last4 = phone.replace(/\D+/g, '').slice(-4) || '0000';
    const suffix = randomBytes(2).toString('hex').toUpperCase();
    return `SLDR-${y}${m}${d}-${last4}-${suffix}`;
}

// Lead pipeline stage progression order. Used to decide whether sending a
// proposal should bump the stage forward — we only bump from "early" stages
// (null/new/qualifying) to "quoted". Sending another proposal to a lead
// already in scheduled/booked/won/lost must NOT regress them.
export const STAGE_ORDER = [
    'new',
    'qualifying',
    'quoted',
    'scheduled',
    'booked',
    'won',
    'lost',
] as const;

export type LeadStageName = (typeof STAGE_ORDER)[number];

/**
 * Returns true if a lead at `currentStage` is allowed to be auto-advanced to
 * 'quoted' as a side effect of sending a proposal. Null and the earliest
 * stages count as "earlier than quoted". 'lost' is excluded — re-quoting a
 * lost lead is a manual decision, not an automatic side effect.
 */
export function shouldBumpToQuoted(currentStage: string | null): boolean {
    if (currentStage == null) return true;
    if (currentStage === 'new' || currentStage === 'qualifying') return true;
    return false;
}
