import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRAPH_API_VERSION as APP_GRAPH_VERSION } from '@/lib/whatsapp/graph';
import {
    GRAPH_API_VERSION,
    SECRET_PHASES,
    WRITE_PHASES,
    appSecretProof,
    generateVerifyToken,
    graphError,
    graphUrl,
    maskPhone,
    parseArgs,
    phoneListHas,
    redact,
    secretPhaseRefusal,
    secretProblem,
    subscribedHasApp,
} from '../wa-provision.mjs';

// Helpers of the provisioning script (Fase 2 task 2.1c). Fake ids and secrets only.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';

describe('parseArgs', () => {
    it('reads the phases and their required arguments', () => {
        const { opts, errors } = parseArgs([
            '--phase=number', '--expect-ref=abcdefghijklmnopqrst', `--org=${ORG}`,
            '--phone-number-id=110000000000001', '--waba-id=210000000000001', '--display-phone=+62 811-0000-0001', '--confirm',
        ]);
        expect(errors).toEqual([]);
        expect(opts).toMatchObject({
            phase: 'number', org: ORG, phoneNumberId: '110000000000001', wabaId: '210000000000001',
            displayPhone: '+62 811-0000-0001', confirm: true,
        });
    });

    it('status needs no org; every other phase does', () => {
        expect(parseArgs(['--phase=status', '--expect-ref=x']).errors).toEqual([]);
        expect(parseArgs(['--phase=verify', '--expect-ref=x']).errors).toContain('--org=<uuid> is required');
    });

    it('checks ids and kinds', () => {
        const app = parseArgs(['--phase=app', '--expect-ref=x', `--org=${ORG}`, '--meta-app-id=abc']);
        expect(app.errors).toContain('--meta-app-id must be 5-25 digits');
        const rotate = parseArgs(['--phase=rotate', '--expect-ref=x', `--org=${ORG}`, '--kind=pin']);
        expect(rotate.errors).toContain('--kind must be one of app_secret, access_token, verify_token');
        expect(parseArgs(['--phase=nope', '--expect-ref=x']).errors[0]).toMatch(/^--phase must be one of/);
        expect(parseArgs(['--phase=status']).errors).toContain('--expect-ref is required');
    });

    it('never echoes an unknown argument (it could be a pasted secret)', () => {
        // Low-entropy fake values, so the repo's secret scanner stays quiet.
        const { errors } = parseArgs(['--phase=status', '--expect-ref=x', '--token=RAHASIA-RAHASIA-RAHASIA', 'RAHASIA-RAHASIA']);
        expect(errors.join(' ')).not.toContain('RAHASIA');
        expect(errors).toContain('unknown argument (secrets are never passed as arguments; the script asks for them)');
    });
});

describe('secrets', () => {
    it('uses the same shapes as migration 0073', () => {
        expect(secretProblem('app_secret', 'a'.repeat(16))).toBeNull();
        expect(secretProblem('app_secret', 'a'.repeat(15))).toBe('must be 16-256 characters long');
        expect(secretProblem('access_token', 'a'.repeat(4096))).toBeNull();
        expect(secretProblem('access_token', 'a'.repeat(4097))).toBe('must be 20-4096 characters long');
        expect(secretProblem('verify_token', 'x')).toBeNull();
        expect(secretProblem('access_token', 'token palsu dengan spasi')).toBe(
            'must be visible ASCII characters without spaces or line breaks'
        );
        expect(secretProblem('access_token', 'tokenpalsu\n0123456789abcdef')).not.toBeNull();
        expect(secretProblem('access_token', '')).not.toBeNull();
        expect(secretProblem('pin', '123456')).toBe('unknown secret kind');
    });

    it('generates a 32-character URL-safe verify token', () => {
        const a = generateVerifyToken();
        expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(generateVerifyToken()).not.toBe(a);
        expect(secretProblem('verify_token', a)).toBeNull();
    });

    it('computes appsecret_proof as HMAC-SHA256(token) keyed with the app secret', () => {
        const expected = crypto.createHmac('sha256', 'rahasia-aplikasi-palsu').update('token-palsu').digest('hex');
        expect(appSecretProof('token-palsu', 'rahasia-aplikasi-palsu')).toBe(expected);
    });

    it('takes secrets only in an interactive terminal', () => {
        for (const phase of SECRET_PHASES) {
            expect(secretPhaseRefusal(phase, { stdin: false, stdout: true })).toMatch(/interactive terminal/);
            expect(secretPhaseRefusal(phase, { stdin: true, stdout: false })).toMatch(/interactive terminal/);
            expect(secretPhaseRefusal(phase, { stdin: true, stdout: true })).toBeNull();
        }
        // The secret-free phases (status, number, verify, ...) run anywhere.
        expect(secretPhaseRefusal('verify', { stdin: false, stdout: false })).toBeNull();
        expect([...SECRET_PHASES].sort()).toEqual(['app', 'rotate']);
        expect(WRITE_PHASES.has('status')).toBe(false);
        expect(WRITE_PHASES.has('verify')).toBe(false);
    });
});

describe('Graph', () => {
    it('uses the app\'s Graph version', () => {
        expect(GRAPH_API_VERSION).toBe(APP_GRAPH_VERSION);
    });

    it('puts the proof in the query and never the token', () => {
        const url = new URL(graphUrl('/210000000000001/subscribed_apps', 'bukti', { fields: 'id' }));
        expect(url.origin + url.pathname).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/210000000000001/subscribed_apps`);
        expect(url.searchParams.get('appsecret_proof')).toBe('bukti');
        expect(url.searchParams.get('fields')).toBe('id');
        expect(url.searchParams.has('access_token')).toBe(false);
    });

    it('redacts query strings and token-like runs from error text', () => {
        const text = redact(
            'fetch failed https://graph.facebook.com/v25.0/1/x?appsecret_proof=abc&fields=id token EAAAAAAAAAAAAAAAAAAA ' +
                'proof ' + 'f'.repeat(64)
        );
        expect(text).toContain('https://graph.facebook.com/v25.0/1/x?<redacted>');
        expect(text).not.toContain('appsecret_proof=abc');
        expect(text).not.toContain('EAAAAAAAAAAAAAAAAAAA');
        expect(text).not.toContain('f'.repeat(64));
        expect(graphError(400, { error: { code: 100, error_subcode: 33, message: 'Invalid appsecret_proof' } })).toBe(
            'HTTP 400 code=100/33 Invalid appsecret_proof'
        );
        expect(graphError(502, null)).toBe('HTTP 502');
    });

    it('reads the subscribed apps and the WABA numbers', () => {
        const subs = { data: [{ whatsapp_business_api_data: { id: '91000000001', name: 'X' } }] };
        expect(subscribedHasApp(subs, '91000000001')).toBe(true);
        expect(subscribedHasApp(subs, '91000000002')).toBe(false);
        expect(subscribedHasApp({}, '91000000001')).toBe(false);
        expect(phoneListHas({ data: [{ id: '110000000000001' }] }, '110000000000001')).toBe(true);
        expect(phoneListHas({ data: [] }, '110000000000001')).toBe(false);
        expect(phoneListHas(null, '110000000000001')).toBe(false);
    });
});

describe('maskPhone', () => {
    it('keeps only the last 4 digits', () => {
        expect(maskPhone('+62 811-0000-0001')).toBe('+•• •••-••••-0001');
        expect(maskPhone('')).toBe('-');
        expect(maskPhone(null)).toBe('-');
    });
});

describe('the script', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../wa-provision.mjs'), 'utf8');

    it('never reads a secret from argv or the environment', () => {
        // Secrets come only from promptHidden; the env holds the Supabase URL and key.
        expect(src).not.toMatch(/process\.env\.(WHATSAPP|META|APP_SECRET|ACCESS_TOKEN)/);
        expect([...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]).sort()).toEqual([
            'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
        ]);
    });

    it('sends the token in the Authorization header only', () => {
        expect(src).toContain('headers: { Authorization: `Bearer ${creds.token}` }');
        expect(src).not.toMatch(/access_token=/);
    });
});
