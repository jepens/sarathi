import { describe, it, expect } from 'vitest';
import {
    classify,
    countsTowardPoison,
    describeItemError,
    MalformedPayloadError,
    opsHint,
    RpcError,
} from '@/lib/whatsapp/webhook/errors';

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

describe('countsTowardPoison', () => {
    it('an outage, a slow or contended database, a schema out of step with the code and a read-only database never count: they hit every item alike', () => {
        for (const code of [
            'PGRST000', 'PGRST003', 'PGRST202', 'PGRST203', 'PGRST205', 'PGRST301',
            '08006', '53300', '57P01', '25006',
            '40001', '40P01', '55P03', '57014',
            '42501', '42883', '42P01', '42703', '42P10',
            '58030', 'XX000', 'XX001',
        ]) {
            expect(countsTowardPoison(new RpcError('wa_ingest_inbound', pg(code), 503)), code).toBe(false);
        }
        expect(countsTowardPoison(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
        expect(countsTowardPoison(Object.assign(new Error('x'), { name: 'PlatformSettingReadError', code: '23503' }))).toBe(false);
    });

    it('no answer, or a gateway that refuses every call (a wrong API key or URL), never counts', () => {
        for (const status of [0, 401, 403, 404, 408, 429, 500, 502, 503]) {
            expect(countsTowardPoison(new RpcError('wa_ingest_inbound', { code: '' }, status)), String(status)).toBe(false);
        }
    });

    it('a thrown bug, a malformed answer and any other database code still count', () => {
        expect(countsTowardPoison(new TypeError('x is not a function'))).toBe(true);
        expect(countsTowardPoison('aneh')).toBe(true);
        for (const code of ['23503', '23505', 'P0002', '2BP01', 'ZZ999']) {
            expect(countsTowardPoison(new RpcError('wa_ingest_inbound', pg(code), 500)), code).toBe(true);
        }
        for (const status of [400, 409, 413]) {
            expect(countsTowardPoison(new RpcError('wa_ingest_inbound', { code: '' }, status)), String(status)).toBe(true);
        }
        // A raw error object (not an RpcError) without a code carries no HTTP status to judge by.
        expect(countsTowardPoison({ code: '', message: 'TypeError: fetch failed' })).toBe(true);
    });
});

describe('opsHint', () => {
    it('names what to check first for the codes the team will meet', () => {
        expect(opsHint(new RpcError('x', pg('PGRST202'), 404))).toBe('fungsi database tidak ditemukan, migrasi belum diterapkan?');
        expect(opsHint(new RpcError('x', pg('42883'), 404))).toBe('fungsi database tidak ditemukan, migrasi belum diterapkan?');
        expect(opsHint(new RpcError('x', pg('PGRST203'), 300))).toBe('dua versi fungsi database, periksa migrasi terakhir');
        for (const code of ['PGRST204', 'PGRST205', '42703', '42P01']) {
            expect(opsHint(new RpcError('x', pg(code), 400)), code).toBe('kolom atau tabel database tidak ditemukan, migrasi belum diterapkan?');
        }
        expect(opsHint(new RpcError('x', pg('42501'), 403))).toBe('izin database (grant) hilang');
        expect(opsHint(new RpcError('x', pg('42P10'), 400))).toBe('skema database tidak cocok dengan kode, periksa migrasi terakhir');
        expect(opsHint(new RpcError('x', pg('PGRST301'), 401))).toBe('kunci API Supabase ditolak, periksa SUPABASE_SERVICE_ROLE_KEY (rotasi kunci?)');
        expect(opsHint(new RpcError('x', { code: '' }, 401))).toBe('kunci API Supabase ditolak, periksa SUPABASE_SERVICE_ROLE_KEY (rotasi kunci?)');
        expect(opsHint(new RpcError('x', { code: '' }, 403))).toBe('kunci API Supabase ditolak, periksa SUPABASE_SERVICE_ROLE_KEY (rotasi kunci?)');
        expect(opsHint(new RpcError('x', { code: '' }, 404))).toBe('alamat Supabase tidak ditemukan, periksa NEXT_PUBLIC_SUPABASE_URL');
        expect(opsHint(new RpcError('x', { code: '' }, 429))).toBe('Supabase sibuk (batas permintaan atau waktu tunggu habis)');
        expect(opsHint(new RpcError('x', { code: '' }, 408))).toBe('Supabase sibuk (batas permintaan atau waktu tunggu habis)');
        expect(opsHint(new RpcError('x', pg('08006'), 503))).toBe('Supabase tidak terjangkau atau sedang gangguan');
        expect(opsHint(new RpcError('x', { code: '' }, 0))).toBe('Supabase tidak terjangkau atau sedang gangguan');
        expect(opsHint(new RpcError('x', { code: '' }, 502))).toBe('Supabase tidak terjangkau atau sedang gangguan');
        expect(opsHint(new RpcError('x', pg('40001'), 500))).toBe('bentrok transaksi, aman bila jarang');
        expect(opsHint(new RpcError('x', pg('55P03'), 500))).toBe('menunggu kunci database terlalu lama');
        expect(opsHint(new RpcError('x', pg('57014'), 500))).toBe('query database dibatalkan karena terlalu lama');
        expect(opsHint(new RpcError('x', pg('XX000'), 500))).toBe('galat internal database, periksa Supabase');
        expect(opsHint(new RpcError('x', pg('58030'), 500))).toBe('galat internal database, periksa Supabase');
        expect(opsHint(Object.assign(new Error('x'), { name: 'PlatformSettingReadError', code: '57014' }))).toBe(
            'org default tidak terbaca, periksa Supabase',
        );
    });

    it('stays silent where no hint fits', () => {
        expect(opsHint(new TypeError('x'))).toBeNull();
        expect(opsHint(new RpcError('x', pg('23503'), 409))).toBeNull();
        expect(opsHint(new RpcError('x', { code: '' }, 400))).toBeNull();
        expect(opsHint(null)).toBeNull();
    });
});
