// Minimal fake of the Supabase JS client for unit-testing the WhatsApp queue
// pipeline. It reproduces just the chained query-builder surface that
// queue-db.ts uses, and routes every terminal call through a single `resolve`
// function so each test can return canned data (or throw, to simulate a DB
// failure). All calls are recorded for assertions.
//
// Supported chains (matching queue-db.ts exactly):
//   from(t).insert(x).select('id').single()
//   from(t).select('...').eq().eq().maybeSingle()
//   from(t).select('...').eq().eq().order().limit(n)
//   from(t).select('...').gte().lte().neq().is().not()  // awaited (range/null)
//   from(t).update(x).in('id', ids)        // awaited
//   from(t).update(x).eq('id', id)         // awaited
//   from(t).upsert(x, opts)                // awaited
//   from(t).insert(x)                      // awaited (no .select)
//   rpc(name, args)

export type SqlOp = 'select' | 'insert' | 'update' | 'upsert' | 'delete' | null;

export interface FakeCall {
    table: string;
    op: SqlOp;
    payload?: unknown;
    filters: Array<[string, string, unknown]>;
    select?: string;
    single?: 'one' | 'maybe' | null;
    limitN?: number;
    upsertOpts?: unknown;
}

export type Resolver = (call: FakeCall) =>
    | { data?: unknown; error?: unknown }
    | Promise<{ data?: unknown; error?: unknown }>;

export interface FakeSupabase {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any;
    calls: FakeCall[];
    rpcCalls: Array<{ name: string; args: unknown }>;
}

export function makeFakeSupabase(opts: {
    resolve?: Resolver;
    rpc?: (name: string, args: unknown) => { data?: unknown; error?: unknown };
}): FakeSupabase {
    const calls: FakeCall[] = [];
    const rpcCalls: Array<{ name: string; args: unknown }> = [];

    function builder(table: string) {
        const ctx: FakeCall = { table, op: null, filters: [], single: null };
        let settled = false;

        const finalize = (): Promise<{ data?: unknown; error?: unknown }> => {
            if (!settled) {
                settled = true;
                calls.push({ ...ctx, filters: [...ctx.filters] });
            }
            // Defer to a microtask so a throwing resolver becomes a rejected
            // promise (mirrors a real async DB error).
            return Promise.resolve().then(() =>
                opts.resolve ? opts.resolve(ctx) : { data: null, error: null }
            );
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b: any = {
            select(sel: string) { if (!ctx.op) ctx.op = 'select'; ctx.select = sel; return b; },
            insert(p: unknown) { ctx.op = 'insert'; ctx.payload = p; return b; },
            update(p: unknown) { ctx.op = 'update'; ctx.payload = p; return b; },
            upsert(p: unknown, o?: unknown) { ctx.op = 'upsert'; ctx.payload = p; ctx.upsertOpts = o; return b; },
            delete() { ctx.op = 'delete'; return b; },
            eq(c: string, v: unknown) { ctx.filters.push(['eq', c, v]); return b; },
            neq(c: string, v: unknown) { ctx.filters.push(['neq', c, v]); return b; },
            gt(c: string, v: unknown) { ctx.filters.push(['gt', c, v]); return b; },
            gte(c: string, v: unknown) { ctx.filters.push(['gte', c, v]); return b; },
            lt(c: string, v: unknown) { ctx.filters.push(['lt', c, v]); return b; },
            lte(c: string, v: unknown) { ctx.filters.push(['lte', c, v]); return b; },
            is(c: string, v: unknown) { ctx.filters.push(['is', c, v]); return b; },
            not(c: string, op: string, v: unknown) { ctx.filters.push(['not', c, [op, v]]); return b; },
            in(c: string, v: unknown) { ctx.filters.push(['in', c, v]); return finalize(); },
            order() { return b; }, // args (column, {ascending}) are ignored by the fake
            limit(n: number) { ctx.limitN = n; return finalize(); },
            maybeSingle() { ctx.single = 'maybe'; return finalize(); },
            single() { ctx.single = 'one'; return finalize(); },
            // Thenable: `await from(t).update(x).eq(...)` / `.upsert(...)` / `.insert(...)`
            then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
                return finalize().then(onF, onR);
            },
        };
        return b;
    }

    const client = {
        from: (t: string) => builder(t),
        rpc: (name: string, args: unknown) => {
            rpcCalls.push({ name, args });
            const r = opts.rpc ? opts.rpc(name, args) : { data: [], error: null };
            return Promise.resolve(r);
        },
    };

    return { client, calls, rpcCalls };
}
