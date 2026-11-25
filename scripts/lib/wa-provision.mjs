// Pure helpers of scripts/wa-provision.mjs (Fase 2 task 2.1c), unit-tested in
// scripts/lib/__tests__/wa-provision.test.ts. No I/O here.

import crypto from 'node:crypto';

/** Same as lib/whatsapp/graph.ts (a parity test keeps them equal). */
export const GRAPH_API_VERSION = 'v25.0';

export const PHASES = ['status', 'app', 'number', 'verify', 'subscribe', 'rotate', 'offboard'];
/** Phases that take a secret typed by a human: never through Claude. */
export const SECRET_PHASES = new Set(['app', 'rotate']);
/** Phases that change the database or Meta; a dry-run without --confirm. */
export const WRITE_PHASES = new Set(['app', 'number', 'subscribe', 'rotate', 'offboard']);
export const SECRET_KINDS = ['app_secret', 'access_token', 'verify_token'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID_RE = /^[0-9]{5,25}$/;

/** Length bounds of migration 0073 (wa_provision_app / wa_rotate_secret). */
const SECRET_BOUNDS = {
    app_secret: [16, 256],
    access_token: [20, 4096],
    verify_token: [1, 256],
};

export const USAGE =
    'Usage: node --env-file=.env.local scripts/wa-provision.mjs --phase=<' +
    PHASES.join('|') +
    '> --expect-ref=<project ref> [--org=<uuid>] [--meta-app-id=<digits>] ' +
    '[--phone-number-id=<digits>] [--waba-id=<digits>] [--display-phone=<text>] ' +
    '[--kind=<app_secret|access_token|verify_token>] [--confirm]';

/** @param {unknown} v */
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
/** @param {unknown} v */
export const isMetaId = (v) => typeof v === 'string' && META_ID_RE.test(v);

/**
 * @param {string[]} argv
 * @returns {{ opts: {phase: string, expectRef: string|null, org: string|null, metaAppId: string|null,
 *   phoneNumberId: string|null, wabaId: string|null, displayPhone: string|null, kind: string|null,
 *   confirm: boolean}, errors: string[] }}
 */
export function parseArgs(argv) {
    const opts = {
        phase: '',
        expectRef: /** @type {string|null} */ (null),
        org: /** @type {string|null} */ (null),
        metaAppId: /** @type {string|null} */ (null),
        phoneNumberId: /** @type {string|null} */ (null),
        wabaId: /** @type {string|null} */ (null),
        displayPhone: /** @type {string|null} */ (null),
        kind: /** @type {string|null} */ (null),
        confirm: false,
    };
    /** @type {Record<string, keyof typeof opts>} */
    const names = {
        phase: 'phase',
        'expect-ref': 'expectRef',
        org: 'org',
        'meta-app-id': 'metaAppId',
        'phone-number-id': 'phoneNumberId',
        'waba-id': 'wabaId',
        'display-phone': 'displayPhone',
        kind: 'kind',
    };
    /** @type {string[]} */
    const errors = [];
    for (const arg of argv) {
        if (arg === '--confirm') {
            opts.confirm = true;
            continue;
        }
        const m = /^--([a-z-]+)=(.*)$/s.exec(arg);
        if (!m || !(m[1] in names)) {
            // Never echo an unknown argument: it could be a secret pasted by mistake.
            errors.push('unknown argument (secrets are never passed as arguments; the script asks for them)');
            continue;
        }
        /** @type {any} */ (opts)[names[m[1]]] = m[2];
    }

    if (!PHASES.includes(opts.phase)) errors.push(`--phase must be one of ${PHASES.join(', ')}`);
    if (!opts.expectRef) errors.push('--expect-ref is required');
    const needsOrg = opts.phase !== 'status';
    if (needsOrg && !isUuid(opts.org)) errors.push('--org=<uuid> is required');
    if (opts.org !== null && !isUuid(opts.org)) errors.push('--org must be a uuid');
    if (opts.phase === 'app' && !isMetaId(opts.metaAppId)) errors.push('--meta-app-id must be 5-25 digits');
    if (opts.phase === 'number') {
        if (!isMetaId(opts.phoneNumberId)) errors.push('--phone-number-id must be 5-25 digits');
        if (!isMetaId(opts.wabaId)) errors.push('--waba-id must be 5-25 digits');
    }
    if (opts.phase === 'rotate' && !SECRET_KINDS.includes(opts.kind ?? '')) {
        errors.push(`--kind must be one of ${SECRET_KINDS.join(', ')}`);
    }
    return { opts, errors: [...new Set(errors)] };
}

/**
 * Why a secret is not acceptable, or null. The same rules as migration 0073:
 * visible ASCII without spaces (a token with a newline would be quoted whole in
 * fetch's error message), within the length bounds of its kind.
 * @param {string} kind @param {unknown} value
 */
export function secretProblem(kind, value) {
    const bounds = SECRET_BOUNDS[/** @type {keyof typeof SECRET_BOUNDS} */ (kind)];
    if (!bounds) return 'unknown secret kind';
    if (typeof value !== 'string' || !/^[!-~]+$/.test(value)) {
        return 'must be visible ASCII characters without spaces or line breaks';
    }
    const [min, max] = bounds;
    if (value.length < min || value.length > max) return `must be ${min}-${max} characters long`;
    return null;
}

/** A new verify token: 32 URL-safe characters (24 random bytes). */
export function generateVerifyToken() {
    return crypto.randomBytes(24).toString('base64url');
}

/** Meta's appsecret_proof: HMAC-SHA256 of the access token, keyed with the app secret (hex). */
export function appSecretProof(accessToken, appSecret) {
    return crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/**
 * A Graph URL with the appsecret_proof. The token itself goes in the
 * Authorization header, never in the URL.
 * @param {string} path @param {string} proof @param {Record<string, string>} [params]
 */
export function graphUrl(path, proof, params = {}) {
    const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('appsecret_proof', proof);
    return url.toString();
}

/**
 * Strip query strings from URLs and mask long secret-looking runs, for error
 * text that may echo a request (the proof sits in the query string).
 * @param {unknown} text
 */
export function redact(text) {
    return String(text ?? '')
        .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, '$1?<redacted>')
        .replace(/\b(EAA[A-Za-z0-9]{10,}|[A-Fa-f0-9]{32,})\b/g, '<redacted>');
}

/**
 * The business number, with all but its last 4 digits masked (logs redact digit
 * runs anyway; this keeps the output readable).
 * @param {unknown} display
 */
export function maskPhone(display) {
    if (typeof display !== 'string' || display === '') return '-';
    const digits = display.replace(/\D/g, '').length;
    let seen = 0;
    return display.replace(/\d/g, (d) => (++seen > digits - 4 ? d : '•'));
}

/**
 * Why a secret-taking phase may not run here, or null. A secret is only ever
 * typed by a human into a hidden prompt: never through a non-interactive shell
 * (an agent, CI, a pipe), so it cannot land in a transcript or a log.
 * @param {string} phase @param {{ stdin: boolean, stdout: boolean }} tty
 */
export function secretPhaseRefusal(phase, tty) {
    if (!SECRET_PHASES.has(phase)) return null;
    if (tty.stdin && tty.stdout) return null;
    return `--phase=${phase} asks for secrets: run it yourself in an interactive terminal, not through a pipe, CI or an AI agent`;
}

/** GET /{waba_id}/subscribed_apps lists this Meta app. @param {any} body @param {string} metaAppId */
export function subscribedHasApp(body, metaAppId) {
    const data = Array.isArray(body?.data) ? body.data : [];
    return data.some((d) => String(d?.whatsapp_business_api_data?.id ?? '') === metaAppId);
}

/** GET /{waba_id}/phone_numbers lists this number. @param {any} body @param {string} phoneNumberId */
export function phoneListHas(body, phoneNumberId) {
    const data = Array.isArray(body?.data) ? body.data : [];
    return data.some((d) => String(d?.id ?? '') === phoneNumberId);
}

/** A Graph error body as one safe line. @param {number} status @param {any} body */
export function graphError(status, body) {
    const e = body?.error;
    if (!e) return `HTTP ${status}`;
    return redact(`HTTP ${status} code=${e.code ?? '-'}${e.error_subcode ? `/${e.error_subcode}` : ''} ${e.message ?? ''}`.trim());
}
