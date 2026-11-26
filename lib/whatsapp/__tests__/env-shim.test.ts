import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

// Static guard (Fase 2 tasks 2.2b and 2.2d): no app file reads a WhatsApp
// credential from env. Since 2.2d every org's credentials come from Vault
// through lib/whatsapp/credentials.ts (WaCreds for one org), so no code path
// can pick up one org's number for another by reading the env; the old env
// shim is gone and the allowlist of readers is empty.
//
// The sources are parsed (TypeScript compiler API), so every way of naming one
// of the five variables in code counts as a read: a property access on any
// object (process.env.X, process.env?.X, env.X after `const env =
// process.env`), an element access or a destructuring binding with that name,
// and a string literal that is exactly the name (process.env[name] with the
// name in a variable). A name inside a longer message, a comment or JSX text
// is not a read.

const SECRET_ENV = new Set([
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'WHATSAPP_VERIFY_TOKEN',
]);
const SHIM = 'lib/whatsapp/credentials.ts';
// The helpers that hand out credentials without a status check: the Vault
// readers (Fase 2 task 2.2c) of an app's secret and an org's token, for the
// webhook (which checks the statuses itself) and getOrgWhatsAppCreds in
// credentials.ts (which every send uses). Their RPC names count too, so a
// direct .rpc() call cannot skip those checks.
const WEBHOOK_ONLY = new Set(['vaultWebhookApp', 'vaultOrgCreds', 'wa_webhook_app', 'wa_org_send_credentials']);
const WEBHOOK_CALLERS = new Set(['lib/whatsapp/webhook/handshake.ts', 'lib/whatsapp/webhook/pipeline.ts']);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST = /\.test\.(ts|tsx)$/;
const SKIP_DIRS = new Set(['__tests__', 'node_modules', '.next', '.git', '.claude']);

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(full);
        return SOURCE.test(name) && !TEST.test(name) ? [full] : [];
    });
}

const root = process.cwd();
const rootFiles = readdirSync(root).filter((name) => SOURCE.test(name) && statSync(join(root, name)).isFile() && !name.endsWith('.d.ts'));
const files = [...['app', 'lib', 'components'].flatMap((dir) => sourceFiles(join(root, dir))), ...rootFiles.map((f) => join(root, f))]
    .map((full) => relative(root, full).split(sep).join('/'))
    .sort();

/** The ways `source` names one of the four variables in code (empty: none). */
function credentialReads(text: string, fileName = 'x.ts'): string[] {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && SECRET_ENV.has(node.name.text)) found.push(`property ${node.name.text}`);
        else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && SECRET_ENV.has(node.argumentExpression.text)) {
            found.push(`element ${node.argumentExpression.text}`);
        } else if (ts.isBindingElement(node)) {
            const key = node.propertyName ?? node.name;
            if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && SECRET_ENV.has(key.text)) found.push(`binding ${key.text}`);
        } else if (ts.isStringLiteralLike(node) && SECRET_ENV.has(node.text)) found.push(`literal ${node.text}`);
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

/**
 * Whether code in `text` names one of the webhook-only helpers: an identifier
 * (a static, aliased, namespace-member, re-exported or destructured use, from
 * any path) or a string literal that is exactly the name (wa['name']).
 * Comments are not code, so prose that mentions a helper is not a use.
 */
function namesWebhookOnlyHelper(text: string, fileName = 'x.ts'): boolean {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let found = false;
    const visit = (node: ts.Node): void => {
        if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && WEBHOOK_ONLY.has(node.text)) found = true;
        if (!found) ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('WhatsApp credentials are never read from env', () => {
    it('scans the app sources and every source file at the root', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(files).toEqual(expect.arrayContaining([SHIM, 'proxy.ts', 'instrumentation.ts', 'next.config.ts']));
    });

    it('no file reads WHATSAPP_ACCESS_TOKEN / _PHONE_NUMBER_ID / _APP_SECRET / _BUSINESS_ACCOUNT_ID / _VERIFY_TOKEN', () => {
        const readers = files.filter((rel) => credentialReads(read(rel), rel).length > 0);
        expect(readers).toEqual([]);
    });

    it('only the webhook (and credentials.ts itself) uses the Vault readers that skip the status checks', () => {
        const users = files.filter((rel) => rel !== SHIM && namesWebhookOnlyHelper(read(rel), rel));
        expect(users.filter((rel) => !WEBHOOK_CALLERS.has(rel))).toEqual([]);
        expect(users).toEqual([...WEBHOOK_CALLERS]);
    });

    it('catches each way of using a webhook-only helper, and not a mention in a comment', () => {
        const uses = [
            "import { vaultOrgCreds } from '@/lib/whatsapp/credentials';",
            "import { vaultOrgCreds as creds } from '../credentials';",
            "import * as wa from '@/lib/whatsapp/credentials'; wa.vaultWebhookApp();",
            "export { vaultOrgCreds } from '@/lib/whatsapp/credentials';",
            "const { vaultOrgCreds } = await import('@/lib/whatsapp/credentials');",
            "const wa = await import('@/lib/whatsapp/credentials'); wa['vaultWebhookApp']();",
            "await supabase.rpc('wa_org_send_credentials', { p_org: orgId });",
            'await supabase.rpc(`wa_webhook_app`, { p_key: key });',
        ];
        for (const use of uses) expect(namesWebhookOnlyHelper(use), use).toBe(true);
        expect(namesWebhookOnlyHelper('/** see vaultOrgCreds */ const x = 1; // vaultWebhookApp')).toBe(false);
        expect(namesWebhookOnlyHelper("import { getOrgWhatsAppCreds } from '@/lib/whatsapp/credentials';")).toBe(false);
    });

    it('catches each form of a read, and not a name inside a message', () => {
        const forms = [
            'process.env.WHATSAPP_ACCESS_TOKEN',
            'process.env?.WHATSAPP_ACCESS_TOKEN',
            "process.env['WHATSAPP_APP_SECRET']",
            'const env = process.env; env.WHATSAPP_PHONE_NUMBER_ID',
            'const { WHATSAPP_ACCESS_TOKEN } = process.env',
            'const { WHATSAPP_ACCESS_TOKEN: token } = process.env',
            "const { 'WHATSAPP_BUSINESS_ACCOUNT_ID': waba } = process.env",
            "envValue('WHATSAPP_PHONE_NUMBER_ID')",
            "process.env.WHATSAPP_VERIFY_TOKEN || ''",
            'const name = `WHATSAPP_APP_SECRET`; process.env[name]',
        ];
        for (const form of forms) expect(credentialReads(form), form).not.toEqual([]);
        const notReads = [
            'process.env.WHATSAPP_OTHER_NUMBER_EVENTS',
            "const detail = 'WHATSAPP_APP_SECRET tidak diset di server';",
            '// reads WHATSAPP_ACCESS_TOKEN',
        ];
        for (const form of notReads) expect(credentialReads(form), form).toEqual([]);
        expect(credentialReads('const x = <code>WHATSAPP_ACCESS_TOKEN</code>;', 'x.tsx')).toEqual([]);
    });
});
