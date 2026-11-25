// Provision a tenant's own Meta app and WhatsApp number into Supabase Vault
// (Fase 2 task 2.1c; owner decisions D6, D17, D29). Uses the service-role RPCs
// of migration 0073 (wa_apps_vault). Until the platform-admin UI (3.1), the
// Sarathi team runs this script.
//
//   node --env-file=.env.local scripts/wa-provision.mjs --expect-ref=<project ref> --phase=...
//
//   --phase=status [--org=<uuid>]       read-only: apps and numbers per org
//                                        (no secret is read or printed)
//   --phase=app --org=<uuid> --meta-app-id=<digits> [--confirm]
//                                        SECRETS: asks for the app secret and the
//                                        System User token in a hidden prompt,
//                                        generates the verify token and shows it
//                                        once, prints the per-app webhook path
//   --phase=number --org=<uuid> --phone-number-id=<digits> --waba-id=<digits>
//                  [--display-phone=<text>] [--confirm]
//   --phase=verify --org=<uuid>         read-only on both sides: with the Vault
//                                        token and an appsecret_proof (which also
//                                        proves the stored app secret belongs to
//                                        the token's app), the number answers,
//                                        the WABA lists it, and the app is
//                                        subscribed to the WABA's webhooks
//   --phase=subscribe --org=<uuid> [--confirm]
//                                        POST /{waba_id}/subscribed_apps
//   --phase=rotate --org=<uuid> --kind=<app_secret|access_token|verify_token> [--confirm]
//                                        SECRETS: the new value in a hidden prompt
//                                        (a new verify token is generated and
//                                        shown once)
//   --phase=offboard --org=<uuid> [--confirm]
//                                        deletes the org's number, app and their
//                                        Vault secrets (wa_offboard_org)
//
// Every writing phase is a dry-run without --confirm.
//
// Safety rails:
//   * refuses when the project ref of NEXT_PUBLIC_SUPABASE_URL is not
//     --expect-ref, or when the key is not a service-role key;
//   * secrets are never arguments, files or environment variables: the
//     phases that take one (app, rotate) refuse to run without an interactive
//     terminal, so they cannot run through a pipe, CI or an AI agent. The
//     owner runs them himself (design review: D17 exception);
//   * nothing secret is printed, except the verify token that app and rotate
//     generate (once, in that terminal, to be typed into the Meta App
//     Dashboard);
//   * Graph calls send the token in the Authorization header, and error text
//     is redacted.
//
// Exit codes: 0 = ok, 1 = a check failed or the run stopped, 2 = usage or a
// safety rail (nothing was done).

import { createClient } from '@supabase/supabase-js';
import { keyRole, projectRefFromUrl } from './lib/legacy-kb.mjs';
import {
    USAGE,
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
} from './lib/wa-provision.mjs';

class Stop extends Error {
    /** @param {number} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** @param {number} code @param {string} message @returns {never} */
function stop(code, message) {
    throw new Stop(code, message);
}

/** @param {any} error */
const errText = (error) => redact(error?.message ?? error ?? 'unknown error');

/**
 * Read a line without echoing it (raw mode). Only reached in an interactive
 * terminal (secretPhaseRefusal).
 * @param {string} label
 * @returns {Promise<string>}
 */
function promptHidden(label) {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        process.stdout.write(label);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let value = '';
        const cleanup = () => {
            stdin.removeListener('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
        };
        /** @param {string} chunk */
        function onData(chunk) {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    cleanup();
                    process.stdout.write(`\n  (received ${value.length} characters)\n`);
                    resolve(value);
                    return;
                }
                if (ch === '\u0003') {
                    cleanup();
                    process.stdout.write('\n');
                    reject(new Stop(1, 'cancelled'));
                    return;
                }
                if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
                else value += ch;
            }
        }
        stdin.on('data', onData);
    });
}

/** Ask for a secret until it has the right shape (3 tries). @param {string} kind @param {string} label */
async function askSecret(kind, label) {
    for (let i = 0; i < 3; i++) {
        const value = await promptHidden(`${label}: `);
        const problem = secretProblem(kind, value);
        if (!problem) return value;
        console.log(`  not accepted: the value ${problem}`);
    }
    return stop(1, `no valid ${label} after 3 tries`);
}

/** @param {any} db @param {string} orgId */
async function loadOrg(db, orgId) {
    const { data, error } = await db.from('organizations').select('id, name').eq('id', orgId).maybeSingle();
    if (error) stop(1, `could not read the org: ${errText(error)}`);
    if (!data) stop(1, `org ${orgId} does not exist`);
    return data;
}

/** @param {any} db @param {string} orgId */
async function loadApp(db, orgId) {
    const { data, error } = await db
        .from('whatsapp_apps')
        .select('id, meta_app_id, webhook_key, status')
        .eq('org_id', orgId)
        .maybeSingle();
    if (error) stop(1, `could not read whatsapp_apps: ${errText(error)}`);
    return data;
}

/** @param {any} db @param {string} orgId */
async function loadNumber(db, orgId) {
    const { data, error } = await db
        .from('whatsapp_integrations')
        .select('id, phone_number_id, waba_id, display_phone, status')
        .eq('org_id', orgId)
        .maybeSingle();
    if (error) stop(1, `could not read whatsapp_integrations: ${errText(error)}`);
    return data;
}

/**
 * The org's Vault credentials, held in memory only. Needs an app and a number.
 * @param {any} db @param {string} orgId
 */
async function loadCreds(db, orgId) {
    const app = await loadApp(db, orgId);
    if (!app) stop(1, 'the org has no app: run --phase=app first');
    const send = await db.rpc('wa_org_send_credentials', { p_org: orgId });
    if (send.error) stop(1, `wa_org_send_credentials failed: ${errText(send.error)}`);
    const row = send.data?.[0];
    if (!row) stop(1, 'the org has no number: run --phase=number first');
    const hook = await db.rpc('wa_webhook_app', { p_key: app.webhook_key });
    if (hook.error) stop(1, `wa_webhook_app failed: ${errText(hook.error)}`);
    const appSecret = hook.data?.[0]?.app_secret;
    if (!appSecret) stop(1, 'the app secret could not be read from Vault');
    return {
        app,
        phoneNumberId: row.phone_number_id,
        wabaId: row.waba_id,
        token: row.access_token,
        proof: appSecretProof(row.access_token, appSecret),
    };
}

/**
 * @param {'GET'|'POST'} method @param {string} path @param {{token: string, proof: string}} creds
 * @param {Record<string, string>} [params]
 */
async function graph(method, path, creds, params) {
    try {
        const res = await fetch(graphUrl(path, creds.proof, params), {
            method,
            headers: { Authorization: `Bearer ${creds.token}` },
        });
        /** @type {any} */
        let body = null;
        try {
            body = await res.json();
        } catch {
            body = null;
        }
        return { ok: res.ok, status: res.status, body };
    } catch (error) {
        return { ok: false, status: 0, body: { error: { message: `network: ${errText(error)}` } } };
    }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** @param {any} db @param {string|null} orgId */
async function phaseStatus(db, orgId) {
    let apps = db.from('whatsapp_apps').select('id, org_id, meta_app_id, webhook_key, status, created_at');
    let nums = db.from('whatsapp_integrations').select('org_id, phone_number_id, waba_id, display_phone, status');
    if (orgId) {
        apps = apps.eq('org_id', orgId);
        nums = nums.eq('org_id', orgId);
    }
    const [a, n, o] = await Promise.all([apps, nums, db.from('organizations').select('id, name')]);
    for (const r of [a, n, o]) if (r.error) stop(1, `read failed: ${errText(r.error)}`);
    const names = new Map((o.data ?? []).map((x) => [x.id, x.name]));
    const numbers = new Map((n.data ?? []).map((x) => [x.org_id, x]));
    if (!a.data?.length) {
        console.log(orgId ? 'This org has no WhatsApp app yet.' : 'No WhatsApp app is provisioned yet.');
        return;
    }
    for (const app of a.data) {
        const num = numbers.get(app.org_id);
        console.log(`org ${app.org_id} (${names.get(app.org_id) ?? '?'})`);
        console.log(`  app ${app.id} meta_app_id=${app.meta_app_id} status=${app.status} created=${app.created_at}`);
        console.log(`  webhook path: /api/webhook/whatsapp/${app.webhook_key}`);
        console.log(
            num
                ? `  number phone_number_id=${num.phone_number_id} waba_id=${num.waba_id} display=${maskPhone(num.display_phone)} status=${num.status}`
                : '  number: none yet (--phase=number)',
        );
    }
}

/** @param {any} db @param {ReturnType<typeof parseArgs>['opts']} opts */
async function phaseApp(db, opts) {
    const org = await loadOrg(db, opts.org);
    if (await loadApp(db, opts.org)) stop(1, 'this org already has an app: use --phase=rotate to change its secrets');
    const { data: taken, error } = await db.from('whatsapp_apps').select('org_id').eq('meta_app_id', opts.metaAppId).maybeSingle();
    if (error) stop(1, `could not read whatsapp_apps: ${errText(error)}`);
    if (taken) stop(1, `Meta app ${opts.metaAppId} already belongs to org ${taken.org_id}`);

    console.log(`Org: ${org.name} (${org.id}); Meta app id: ${opts.metaAppId}`);
    if (!opts.confirm) {
        console.log('Dry-run: with --confirm the script asks for the app secret and the System User token');
        console.log('(hidden input), generates a verify token, and stores the secrets in Vault.');
        return;
    }
    const appSecret = await askSecret('app_secret', 'App secret (Meta App Dashboard > App settings > Basic)');
    const accessToken = await askSecret('access_token', 'System User token (permanent, with whatsapp_business_messaging and whatsapp_business_management)');
    const verifyToken = generateVerifyToken();
    const { data, error: rpcError } = await db.rpc('wa_provision_app', {
        p_org: opts.org,
        p_meta_app_id: opts.metaAppId,
        p_app_secret: appSecret,
        p_access_token: accessToken,
        p_verify_token: verifyToken,
    });
    if (rpcError) stop(1, `wa_provision_app failed: ${errText(rpcError)}`);
    const row = data?.[0];
    const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
    console.log(`\nProvisioned app ${row.app_id}.`);
    console.log(`Webhook callback URL: ${base || 'https://<app domain>'}/api/webhook/whatsapp/${row.webhook_key}`);
    console.log('  (the per-app route arrives with task 2.2c; configure it in Meta only after that deploy)');
    console.log(`Verify token, shown ONCE, for the same Meta screen: ${verifyToken}`);
    console.log('Next: --phase=number, then --phase=verify.');
}

/** @param {any} db @param {ReturnType<typeof parseArgs>['opts']} opts */
async function phaseNumber(db, opts) {
    const org = await loadOrg(db, opts.org);
    const app = await loadApp(db, opts.org);
    if (!app) stop(1, 'the org has no app: run --phase=app first');
    if (await loadNumber(db, opts.org)) stop(1, 'this org already has a number (one number per org in the pilot)');
    const display = opts.displayPhone ? maskPhone(opts.displayPhone) : '-';
    console.log(`Org: ${org.name}; app ${app.id}; phone_number_id=${opts.phoneNumberId} waba_id=${opts.wabaId} display=${display}`);
    if (!opts.confirm) {
        console.log('Dry-run: re-run with --confirm to add the number.');
        return;
    }
    const { data, error } = await db.rpc('wa_provision_number', {
        p_app: app.id,
        p_phone_number_id: opts.phoneNumberId,
        p_waba_id: opts.wabaId,
        p_display_phone: opts.displayPhone,
    });
    if (error) stop(1, `wa_provision_number failed: ${errText(error)}`);
    console.log(`Added number ${data}. Next: --phase=verify.`);
}

/** @param {any} db @param {ReturnType<typeof parseArgs>['opts']} opts */
async function phaseVerify(db, opts) {
    await loadOrg(db, opts.org);
    const creds = await loadCreds(db, opts.org);
    let failed = 0;
    /** @param {boolean} ok @param {string} text */
    const report = (ok, text) => {
        if (!ok) failed++;
        console.log(`${ok ? 'OK  ' : 'FAIL'} ${text}`);
    };

    const num = await graph('GET', creds.phoneNumberId, creds, { fields: 'display_phone_number,verified_name,quality_rating' });
    if (num.ok) {
        report(true, `number answers: ${maskPhone(num.body?.display_phone_number)} "${num.body?.verified_name ?? '-'}" quality=${num.body?.quality_rating ?? '-'}`);
    } else {
        const proofHint = /appsecret_proof/i.test(JSON.stringify(num.body ?? {}))
            ? ' (the app secret in Vault does not belong to the token\'s app: --phase=rotate --kind=app_secret)'
            : '';
        report(false, `number does not answer: ${graphError(num.status, num.body)}${proofHint}`);
    }

    const list = await graph('GET', `${creds.wabaId}/phone_numbers`, creds);
    const listed = list.ok && phoneListHas(list.body, creds.phoneNumberId);
    report(
        listed,
        list.ok
            ? listed
                ? 'the WABA lists this number'
                : 'the WABA does NOT list this number (wrong waba_id or phone_number_id?)'
            : `the WABA's numbers cannot be read: ${graphError(list.status, list.body)}`,
    );

    const subs = await graph('GET', `${creds.wabaId}/subscribed_apps`, creds);
    const subscribed = subs.ok && subscribedHasApp(subs.body, creds.app.meta_app_id);
    report(
        subscribed,
        subs.ok
            ? subscribed
                ? 'the app is subscribed to the WABA\'s webhooks'
                : 'the app is NOT subscribed to the WABA\'s webhooks: --phase=subscribe'
            : `subscriptions cannot be read: ${graphError(subs.status, subs.body)}`,
    );
    report(creds.app.status === 'active', `app status in Sarathi: ${creds.app.status}`);
    if (failed) stop(1, `${failed} check(s) failed`);
    console.log('All checks passed.');
}

/** @param {any} db @param {ReturnType<typeof parseArgs>['opts']} opts */
async function phaseSubscribe(db, opts) {
    await loadOrg(db, opts.org);
    const creds = await loadCreds(db, opts.org);
    console.log(`Subscribe Meta app ${creds.app.meta_app_id} to the webhooks of WABA ${creds.wabaId}.`);
    if (!opts.confirm) {
        console.log('Dry-run: re-run with --confirm.');
        return;
    }
    const res = await graph('POST', `${creds.wabaId}/subscribed_apps`, creds);
    if (!res.ok || res.body?.success !== true) stop(1, `subscribe failed: ${graphError(res.status, res.body)}`);
    console.log('Subscribed. Check with --phase=verify.');
}

/** @param {any} db @param {ReturnType<typeof parseArgs>['opts']} opts */
async function phaseRotate(db, opts) {
    const org = await loadOrg(db, opts.org);
    const app = await loadApp(db, opts.org);
    if (!app) stop(1, 'the org has no app');
    console.log(`Org: ${org.name}; app ${app.id}; rotate ${opts.kind}`);
    if (opts.kind === 'app_secret') {
        console.log('Order: reset the secret in the Meta App Dashboard first, then store it here at once.');
        console.log('Webhooks signed with the old secret fail until then; Meta retries them.');
    }
    if (!opts.confirm) {
        console.log('Dry-run: re-run with --confirm to enter the new value.');
        return;
    }
    const kind = /** @type {string} */ (opts.kind);
    const value =
        kind === 'verify_token'
            ? generateVerifyToken()
            : await askSecret(kind, kind === 'app_secret' ? 'New app secret' : 'New System User token');
    const { error } = await db.rpc('wa_rotate_secret', { p_app: app.id, p_kind: kind, p_secret: value });
    if (error) stop(1, `wa_rotate_secret failed: ${errText(error)}`);
    if (kind === 'verify_token') {
        console.log(`New verify token, shown ONCE (enter it in the Meta App Dashboard webhook settings): ${value}`);
    }
    console.log(`Rotated ${kind}.${kind !== 'verify_token' ? ' Check with --phase=verify.' : ''}`);
}

/** @param {any} db @param {ReturnType<typeof parseArgs>['opts']} opts */
async function phaseOffboard(db, opts) {
    const org = await loadOrg(db, opts.org);
    const app = await loadApp(db, opts.org);
    const num = await loadNumber(db, opts.org);
    if (!app && !num) {
        console.log('Nothing to offboard: the org has no app and no number.');
        return;
    }
    console.log(`Org: ${org.name}; app ${app?.id ?? '-'}; number ${num?.phone_number_id ?? '-'}`);
    console.log('This deletes the number and app rows and their Vault secrets. The client keeps its Meta app;');
    console.log('remove the Sarathi callback URL there if the client leaves.');
    if (!opts.confirm) {
        console.log('Dry-run: re-run with --confirm.');
        return;
    }
    const { error } = await db.rpc('wa_offboard_org', { p_org: opts.org });
    if (error) stop(1, `wa_offboard_org failed: ${errText(error)}`);
    console.log('Offboarded.');
}

async function main() {
    const { opts, errors } = parseArgs(process.argv.slice(2));
    if (errors.length) stop(2, `${errors.join('; ')}\n${USAGE}`);
    const refusal = secretPhaseRefusal(opts.phase, {
        stdin: Boolean(process.stdin.isTTY),
        stdout: Boolean(process.stdout.isTTY),
    });
    if (refusal) stop(2, refusal);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ref = projectRefFromUrl(url);
    if (!ref || ref !== opts.expectRef) {
        stop(2, `the project ref of NEXT_PUBLIC_SUPABASE_URL (${ref ?? 'not recognised'}) is not --expect-ref`);
    }
    const role = keyRole(key);
    if (role !== 'service_role' && role !== 'secret') stop(2, `SUPABASE_SERVICE_ROLE_KEY is not a service-role key (${role})`);
    if (WRITE_PHASES.has(opts.phase)) console.log(opts.confirm ? `Project ${ref}: WRITE run.` : `Project ${ref}: dry-run.`);

    const db = createClient(/** @type {string} */ (url), /** @type {string} */ (key), {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    switch (opts.phase) {
        case 'status':
            return phaseStatus(db, opts.org);
        case 'app':
            return phaseApp(db, opts);
        case 'number':
            return phaseNumber(db, opts);
        case 'verify':
            return phaseVerify(db, opts);
        case 'subscribe':
            return phaseSubscribe(db, opts);
        case 'rotate':
            return phaseRotate(db, opts);
        case 'offboard':
            return phaseOffboard(db, opts);
        default:
            return stop(2, USAGE);
    }
}

main().then(
    () => process.exit(0),
    (error) => {
        if (error instanceof Stop) {
            console.error(error.message);
            process.exit(error.code);
        }
        console.error(`Unexpected error: ${errText(error)}`);
        process.exit(1);
    },
);
