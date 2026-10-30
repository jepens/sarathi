import { describe, it, expect } from 'vitest';
import { classify, describeItemError, MalformedPayloadError, RpcError } from '@/lib/whatsapp/webhook/errors';

// Retryable or permanent (Fase 2 task 2.2a part 2): a retryable item answers
// 503 and Meta sends the batch again; a permanent one is stored as a
// placeholder or skipped (200). Only errors that say the input itself is
// wrong are permanent; anything else, including what nobody foresaw, is
// retryable (the poison counter bounds the retries).

// A PostgREST error as supabase-js returns it (not thrown).
const pg = (code: string) => ({ code, message: 'm', details: '', hint: '' });

describe('classify', () => {
    it.each([
        // class 22, including the RPC's own validation errors
        ['22004', 'null value not allowed (the RPC validation)'],
        ['22023', 'invalid parameter value (the RPC validation)'],
        ['22P02', 'invalid text representation'],
        ['22P05', 'unsupported Unicode escape sequence (U+0000 in jsonb)'],
        ['22021', 'character not in repertoire'],
        ['22001', 'string data right truncation'],
        ['23502', 'not null violation'],
        ['23514', 'check violation'],
        ['P0001', 'raise exception'],
        ['PGRST100', 'PostgREST could not parse the request'],
        ['PGRST102', 'invalid request body'],
        ['PGRST116', 'PostgREST 1xx'],
    ])('%s (%s) is permanent', (code) => {
        expect(classify(pg(code))).toBe('permanent');
        expect(classify(new RpcError('wa_ingest_inbound', pg(code), 400))).toBe('permanent');
    });

    it.each([
        ['', 'network failure or abort (postgrest-js answers code "")'],
        ['PGRST000', 'PostgREST cannot connect'],
        ['PGRST001', 'PostgREST connection error'],
        ['PGRST002', 'schema cache not ready'],
        ['PGRST003', 'pool timeout'],
        ['PGRST202', 'function not found (code ahead of 0072)'],
        ['PGRST204', 'column not found in the schema cache'],
        ['PGRST301', 'JWT error'],
        ['PGRST303', 'JWT claims'],
        ['08006', 'connection failure'],
        ['08000', 'connection exception'],
        ['40001', 'serialization failure'],
        ['40P01', 'deadlock'],
        ['53300', 'too many connections'],
        ['53100', 'disk full'],
        ['55P03', 'lock_timeout'],
        ['57014', 'statement timeout'],
        ['57P01', 'admin shutdown'],
        ['57P03', 'cannot connect now'],
        ['58000', 'system error'],
        ['XX000', 'internal error'],
        ['23503', 'foreign key violation (a contact deleted meanwhile)'],
        ['23505', 'unique violation that slipped past an ON CONFLICT'],
        ['42501', 'insufficient privilege'],
        ['42883', 'undefined function'],
        ['42P01', 'undefined table (an unknown code)'],
        ['ZZ999', 'a code nobody knows'],
    ])('"%s" (%s) is retryable', (code) => {
        expect(classify(pg(code))).toBe('retryable');
        expect(classify(new RpcError('wa_ingest_inbound', pg(code), 503))).toBe('retryable');
    });

    it('HTTP failures without a code are retryable: no answer, 408, 429, 5xx', () => {
        for (const status of [0, 408, 429, 500, 502, 503, 504]) {
            expect(classify(new RpcError('wa_ingest_inbound', { message: 'x' }, status))).toBe('retryable');
        }
    });

    it('any thrown error, and anything that is not an error object, is retryable (the default)', () => {
        expect(classify(new Error('boom'))).toBe('retryable');
        expect(classify(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe('retryable');
        for (const odd of [undefined, null, 'teks', 42, {}, { code: 22004 }]) expect(classify(odd)).toBe('retryable');
    });

    it("the default org's read error is retryable whatever database code it carries", () => {
        const err = Object.assign(new Error('platform setting default_org_id could not be read (22P02)'), {
            name: 'PlatformSettingReadError',
            code: '22P02',
        });
        expect(classify(err)).toBe('retryable');
    });

    it('a malformed payload is permanent', () => {
        expect(classify(new MalformedPayloadError('teks tanpa isi'))).toBe('permanent');
    });
});

describe('RpcError', () => {
    it('keeps the code and the HTTP status, never the message PostgREST sent (it can quote the row)', () => {
        const err = new RpcError('wa_ingest_inbound', { code: '23505', message: 'Key (phone_number)=(620000000001) already exists' }, 409);
        expect(err.code).toBe('23505');
        expect(err.status).toBe(409);
        expect(err.message).toBe('wa_ingest_inbound failed (HTTP 409, 23505)');
        expect(JSON.stringify({ ...err, message: err.message })).not.toContain('620000000001');
    });

    it('is named after what failed when there is no code', () => {
        expect(new RpcError('x', { message: 'FetchError: fetch failed', code: '' }, 0).name).toBe('RpcNetworkError');
        expect(new RpcError('x', { message: '<html>' }, 502).name).toBe('RpcHttp502');
        expect(new RpcError('x', { code: '57014' }, 500).name).toBe('RpcError');
        expect(new RpcError('x', null, undefined).status).toBe(0);
    });
});

describe('describeItemError', () => {
    it('the fixed reason of a malformed payload; the database code; else the class name', () => {
        expect(describeItemError(new MalformedPayloadError('teks tanpa isi'))).toBe('teks tanpa isi');
        expect(describeItemError(new RpcError('wa_ingest_inbound', { code: '40001' }, 500))).toBe('database 40001');
        expect(describeItemError(new RpcError('wa_ingest_inbound', { code: '' }, 0))).toBe('RpcNetworkError');
        expect(describeItemError(new TypeError('x'))).toBe('TypeError');
    });
});
