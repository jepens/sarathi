import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

// Static guard (Fase 2 task 2.2b): the WhatsApp credentials are read in ONE
// place, the Phase-0 env shim lib/whatsapp/credentials.ts. Every send gets
// them from there for one org (WaCreds), so no code path can pick up the
// default org's number for another org by reading the env itself. At the
// contract (2.2d) the shim goes and this allowlist becomes empty.
//
// The sources are parsed (TypeScript compiler API), so every way of naming one
// of the four variables in code counts as a read: a property access on any
// object (process.env.X, process.env?.X, env.X after `const env =
// process.env`), an element access or a destructuring binding with that name,
// and a string literal that is exactly the name (process.env[name] with the
// name in a variable). A name inside a longer message, a comment or JSX text
// is not a read.

const SECRET_ENV = new Set(['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_BUSINESS_ACCOUNT_ID']);
const SHIM = 'lib/whatsapp/credentials.ts';
// The two helpers that hand out the default org's credentials without an org
// check: the webhook's own (the number a delivery arrived on).
const WEBHOOK_ONLY = new Set(['resolveWhatsAppContext', 'envWebhookApp']);
const WEBHOOK_CALLERS = new Set(['lib/whatsapp/webhook/pipeline.ts']);
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

/** The names a file imports from the credentials module. */
function credentialImports(text: string, fileName: string): string[] {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    return source.statements.flatMap((stmt) => {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) return [];
        if (!/(^|\/)whatsapp\/credentials$|^\.\/credentials$/.test(stmt.moduleSpecifier.text)) return [];
        const named = stmt.importClause?.namedBindings;
        return named && ts.isNamedImports(named) ? named.elements.map((e) => (e.propertyName ?? e.name).text) : [];
    });
}

const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('WhatsApp credentials are read only by the env shim', () => {
    it('scans the app sources and every source file at the root', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(files).toEqual(expect.arrayContaining([SHIM, 'proxy.ts', 'instrumentation.ts', 'next.config.ts']));
    });

    it('no other file reads WHATSAPP_ACCESS_TOKEN / _PHONE_NUMBER_ID / _APP_SECRET / _BUSINESS_ACCOUNT_ID', () => {
        const readers = files.filter((rel) => credentialReads(read(rel), rel).length > 0);
        expect(readers).toEqual([SHIM]);
    });

    it("only the webhook uses the helpers that hand out the default org's credentials without an org check", () => {
        const users = files.filter((rel) => rel !== SHIM && credentialImports(read(rel), rel).some((name) => WEBHOOK_ONLY.has(name)));
        expect(users.filter((rel) => !WEBHOOK_CALLERS.has(rel))).toEqual([]);
        expect(users).toEqual([...WEBHOOK_CALLERS]);
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
