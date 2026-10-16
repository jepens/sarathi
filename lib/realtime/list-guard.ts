// Whole-list reads vs. targeted changes (tracker 1.9). A view that both
// reloads its whole list (RESYNC, a truncated event, a poll) and applies
// targeted changes from the org bus (rows read by id and merged, ids dropped
// on DELETE) must not let a slow whole-list read undo a newer targeted
// change: coalesce() never waits for a previous run, so reads overlap and can
// land in any order.
//
// Every whole-list read takes a ticket when it starts; every targeted change
// is stamped as it is applied. When a read lands, it is dropped if a read
// that started later has already been applied, and otherwise the changes
// stamped after its ticket are re-applied on top of it.

export interface ListGuard<T extends { id: string }> {
    /** Ticket for a whole-list read, taken when the read starts. */
    begin(): number;
    /** Rows read by id and merged into the list (their newer state wins). */
    noteUpsert(ids: Iterable<string>): void;
    /** Ids dropped from the list (a DELETE event). */
    noteDelete(ids: Iterable<string>): void;
    /**
     * The list to show once the read with `ticket` returned `fresh`, given the
     * `current` list: null when a later read was already applied (drop this
     * one), else `fresh` with every newer targeted change kept. Idempotent for
     * the same arguments (React may call a state updater twice).
     */
    settle(ticket: number, fresh: readonly T[], current: readonly T[]): T[] | null;
}

export function createListGuard<T extends { id: string }>(): ListGuard<T> {
    let seq = 0;
    let lastApplied = -1;
    const upserted = new Map<string, number>();
    const deleted = new Map<string, number>();
    return {
        begin() {
            seq += 1;
            return seq;
        },
        noteUpsert(ids) {
            seq += 1;
            for (const id of ids) {
                upserted.set(id, seq);
                deleted.delete(id);
            }
        },
        noteDelete(ids) {
            seq += 1;
            for (const id of ids) {
                deleted.set(id, seq);
                upserted.delete(id);
            }
        },
        settle(ticket, fresh, current) {
            if (ticket < lastApplied) return null;
            lastApplied = ticket;
            const byId = new Map(fresh.map((row) => [row.id, row] as const));
            for (const row of current) {
                if ((upserted.get(row.id) ?? -1) > ticket) byId.set(row.id, row);
            }
            for (const [id, at] of deleted) {
                if (at > ticket) byId.delete(id);
            }
            // What this read reflects is no longer needed: no older read is
            // applied after it.
            for (const [id, at] of upserted) if (at <= ticket) upserted.delete(id);
            for (const [id, at] of deleted) if (at <= ticket) deleted.delete(id);
            return Array.from(byId.values());
        },
    };
}
