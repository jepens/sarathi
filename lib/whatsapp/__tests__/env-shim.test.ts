import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Static guard (Fase 2 task 2.2b): the WhatsApp credentials are read in ONE
// place, the Phase-0 env shim lib/whatsapp/credentials.ts. Every send gets
// them from there for one org (WaCreds), so no code path can pick up the
// default org's number for another org by reading the env itself. At the
// contract (2.2d) the shim goes and this allowlist becomes empty.

const SECRET_ENV = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_BUSINESS_ACCOUNT_ID'];
const ALLOWED = new Set(['lib/whatsapp/credentials.ts']);
const ROOTS = ['app', 'lib', 'components'];
const ROOT_FILES = ['instrumentation.ts', 'proxy.ts', 'next.config.ts'];

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(full);
        return /\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
    });
}

const names = SECRET_ENV.join('|');
// process.env.NAME, process.env['NAME'], or the bare name as a string literal
// (a dynamic read such as process.env[name]); a name inside a longer message
// or JSX text is not a read.
const READ = new RegExp(`process\\.env\\s*(?:\\.\\s*(?:${names})\\b|\\[\\s*['"\`](?:${names})['"\`]\\s*\\])|['"\`](?:${names})['"\`]`);

const files = [
    ...ROOTS.flatMap((root) => sourceFiles(join(process.cwd(), root))),
    ...ROOT_FILES.map((f) => join(process.cwd(), f)),
].map((full) => relative(process.cwd(), full).split(sep).join('/'));

describe('WhatsApp credentials are read only by the env shim', () => {
    it('scans the app sources', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(files).toContain('lib/whatsapp/credentials.ts');
    });

    it('no other file reads WHATSAPP_ACCESS_TOKEN / _PHONE_NUMBER_ID / _APP_SECRET / _BUSINESS_ACCOUNT_ID', () => {
        const readers = files.filter((rel) => READ.test(readFileSync(join(process.cwd(), rel), 'utf8')));
        expect(readers.filter((rel) => !ALLOWED.has(rel))).toEqual([]);
        // The shim itself still reads them (the pattern would notice a rename).
        expect(readers).toEqual(['lib/whatsapp/credentials.ts']);
    });

    it('the pattern catches each form of a read', () => {
        expect(READ.test('process.env.WHATSAPP_ACCESS_TOKEN')).toBe(true);
        expect(READ.test("process.env['WHATSAPP_APP_SECRET']")).toBe(true);
        expect(READ.test("envValue('WHATSAPP_PHONE_NUMBER_ID')")).toBe(true);
        expect(READ.test('process.env.WHATSAPP_OTHER_NUMBER_EVENTS')).toBe(false);
        expect(READ.test("'WHATSAPP_APP_SECRET tidak diset di server'")).toBe(false);
    });
});
