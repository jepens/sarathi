import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchPortalClients } from '@/lib/portal/client';

// First stub-fetch suite in the repo: searchPortalClients does outbound HTTP, so
// we replace global fetch with a canned Response. Covers the UUID picker filter
// (#6) and the body-read timeout mapping (#2).

const VALID = '11111111-1111-4111-8111-111111111111';
const VALID2 = '22222222-2222-4222-9222-222222222222';

function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

describe('searchPortalClients', () => {
    const prevBase = process.env.PORTAL_BASE_URL;
    const prevToken = process.env.PORTAL_INTAKE_TOKEN;

    beforeEach(() => {
        process.env.PORTAL_BASE_URL = 'https://portal.example.com';
        process.env.PORTAL_INTAKE_TOKEN = 'secret';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        if (prevBase === undefined) delete process.env.PORTAL_BASE_URL;
        else process.env.PORTAL_BASE_URL = prevBase;
        if (prevToken === undefined) delete process.env.PORTAL_INTAKE_TOKEN;
        else process.env.PORTAL_INTAKE_TOKEN = prevToken;
    });

    it('keeps only clients whose id is a valid UUID', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                jsonResponse({
                    clients: [
                        { id: VALID, name: 'PT Alpha' },
                        { id: 'not-a-uuid', name: 'PT Slug' },
                        { id: '12345', name: 'PT Numeric' },
                        { id: VALID2, name: 'PT Beta' },
                    ],
                })
            )
        );

        const result = await searchPortalClients('pt');

        // The two non-UUID rows (which handoffInputSchema would reject on submit)
        // are dropped so the picker only ever shows handoff-able clients.
        expect(result).toEqual([
            { id: VALID, name: 'PT Alpha' },
            { id: VALID2, name: 'PT Beta' },
        ]);
    });

    it('tolerates a bare array payload', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse([{ id: VALID, name: 'PT Alpha' }]))
        );
        expect(await searchPortalClients('pt')).toEqual([{ id: VALID, name: 'PT Alpha' }]);
    });

    it('maps a timeout during the body read to a PortalError (does not hang)', async () => {
        // fetch resolves (headers received) but res.json() rejects as a
        // TimeoutError — exactly what AbortSignal.timeout throws when the body
        // stream stalls past the deadline.
        const stalledRes = {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => {
                const err = new Error('The operation timed out.');
                err.name = 'TimeoutError';
                throw err;
            },
        } as unknown as Response;
        vi.stubGlobal('fetch', vi.fn(async () => stalledRes));

        await expect(searchPortalClients('pt')).rejects.toThrow(/timeout/i);
    });
});
