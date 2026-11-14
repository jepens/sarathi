import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

// Structural guard (KUA-14): EVERY exported user-facing API route handler must
// go through the central org context — requireOrgContext(),
// requireEnvIntegration(), requireWhatsAppIntegration() (lib/whatsapp/
// integration.ts) or (session-only) requireUserContext() — before the body is
// parsed, data is touched or an external call is made. A new handler
// that forgets the gate (or moves it below other work) fails here.
//
// The check parses each route with the TypeScript compiler API and inspects
// each exported HTTP handler on its own (a gated GET does not cover an ungated
// POST in the same file). For every handler:
//   - it must be a function literal (`export async function GET`,
//     `export const GET = async () =>`); a wrapped or re-exported handler
//     (`export const GET = wrap(fn)`, `export { h as GET }`, `export *`) is
//     refused, since its gate cannot be checked;
//   - the gate is a TOP-LEVEL statement of the handler body (or of a top-level
//     try block) of the form `const x = await gate(...)`, immediately followed
//     by `if (!x.ok) return ...` — so the gate cannot sit in a conditional or
//     have its result ignored;
//   - nothing before it awaits or calls anything (no fire-and-forget fetch, no
//     `.then()` chain). Nested function literals are not executed there and
//     are ignored.
//
// Handlers with EXTERNAL side effects through the env (default-org)
// credentials, or through the org's WhatsApp credentials, must verify the
// session with the Auth server (revocation, F1-B item 3): ENV_INTEGRATION pins
// the exact gate per handler — including the server actions that do the same
// — so switching one back to the plain requireOrgContext() cannot reopen the
// gap silently.
//
// Routes with their OWN authentication are exempt:
//   - webhook/whatsapp — Meta signature (X-Hub-Signature-256);
//   - queue/process    — cron bearer secret.
// (/auth/confirm lives outside app/api.)

const API_DIR = join(process.cwd(), 'app', 'api');
const EXEMPT = new Set(['webhook/whatsapp/route.ts', 'queue/process/route.ts']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const GATES = new Set(['requireOrgContext', 'requireUserContext', 'requireEnvIntegration', 'requireWhatsAppIntegration']);

function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === '__tests__' ? [] : routeFiles(full);
        return name === 'route.ts' ? [full] : [];
    });
}

const files = routeFiles(API_DIR)
    .map((full) => relative(API_DIR, full).split(sep).join('/'))
    .filter((rel) => !EXEMPT.has(rel))
    .sort();

type FnBody = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

interface Handler {
    name: string;
    fn: FnBody | null;
    /** Why the handler cannot be checked (wrapped / re-exported). */
    problem?: string;
}

function isExported(node: ts.Node): boolean {
    return (
        ts.canHaveModifiers(node) &&
        (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    );
}

/**
 * Exported functions named in `names` (HTTP methods by default). A matching
 * export that is not a function literal comes back with `fn: null` and a
 * `problem`, so it fails instead of being skipped.
 */
function findHandlers(source: ts.SourceFile, names: Set<string> = METHODS): Handler[] {
    const handlers: Handler[] = [];
    for (const stmt of source.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt) && names.has(stmt.name.text)) {
            handlers.push({ name: stmt.name.text, fn: stmt });
        }
        if (ts.isVariableStatement(stmt) && isExported(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name) || !names.has(decl.name.text)) continue;
                const init = decl.initializer;
                if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                    handlers.push({ name: decl.name.text, fn: init });
                } else {
                    handlers.push({
                        name: decl.name.text,
                        fn: null,
                        problem: `export const ${decl.name.text} is not a function literal`,
                    });
                }
            }
        }
        if (ts.isExportDeclaration(stmt)) {
            if (!stmt.exportClause) {
                handlers.push({ name: '*', fn: null, problem: '`export *` hides which handlers are exported' });
            } else if (ts.isNamedExports(stmt.exportClause)) {
                for (const el of stmt.exportClause.elements) {
                    if (names.has(el.name.text)) {
                        handlers.push({
                            name: el.name.text,
                            fn: null,
                            problem: `${el.name.text} is re-exported through an export specifier`,
                        });
                    }
                }
            }
        }
    }
    return handlers;
}

/**
 * True when `node` awaits — or, unless `awaitsOnly`, calls — anything outside
 * nested function literals.
 */
function doesWork(node: ts.Node, awaitsOnly = false): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found) return;
        const isCall = ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n);
        if (ts.isAwaitExpression(n) || (!awaitsOnly && isCall)) {
            found = true;
            return;
        }
        if (ts.isFunctionLike(n)) return; // not executed here
        ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
}

/** `const x = await gate(...)` → { id: 'x', call }, else null. */
function gateDeclaration(stmt: ts.Statement): { id: string; call: ts.CallExpression } | null {
    if (!ts.isVariableStatement(stmt) || stmt.declarationList.declarations.length !== 1) return null;
    const decl = stmt.declarationList.declarations[0];
    const init = decl.initializer;
    if (!ts.isIdentifier(decl.name) || !init || !ts.isAwaitExpression(init)) return null;
    const call = init.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !GATES.has(call.expression.text)) {
        return null;
    }
    return { id: decl.name.text, call };
}

/** `if (!x.ok) return ...` or `if (!x.ok) { ...; return ... }`. */
function isRefusalCheck(stmt: ts.Statement | undefined, id: string): boolean {
    if (!stmt || !ts.isIfStatement(stmt)) return false;
    const cond = stmt.expression;
    const testsOk =
        ts.isPrefixUnaryExpression(cond) &&
        cond.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isPropertyAccessExpression(cond.operand) &&
        ts.isIdentifier(cond.operand.expression) &&
        cond.operand.expression.text === id &&
        cond.operand.name.text === 'ok';
    const then = stmt.thenStatement;
    const returns = ts.isReturnStatement(then) || (ts.isBlock(then) && then.statements.some(ts.isReturnStatement));
    return testsOk && returns;
}

interface GateCheck {
    /** The gate called, when the handler passes every rule. */
    gate: string | null;
    /** The gate call's arguments as source text. */
    args: string[];
    problem: string | null;
}

/**
 * Applies the gate rules above to one handler. `syncPrelude` relaxes "nothing
 * before the gate calls anything" to "nothing before it awaits" — for server
 * actions, which validate their arguments synchronously before the gate.
 */
function checkGate(handler: Handler, syncPrelude = false): GateCheck {
    const fail = (problem: string): GateCheck => ({ gate: null, args: [], problem });
    if (!handler.fn) return fail(handler.problem ?? 'not a function literal');
    const body = handler.fn.body;
    if (!body || !ts.isBlock(body)) return fail('handler body is not a block');

    const scan = (statements: readonly ts.Statement[], allowTry: boolean): GateCheck | null => {
        for (let i = 0; i < statements.length; i++) {
            const stmt = statements[i];
            const gate = gateDeclaration(stmt);
            if (gate) {
                if (!isRefusalCheck(statements[i + 1], gate.id)) {
                    return fail(`\`${stmt.getText()}\` is not followed by \`if (!${gate.id}.ok) return ...\``);
                }
                return {
                    gate: (gate.call.expression as ts.Identifier).text,
                    args: gate.call.arguments.map((a) => a.getText()),
                    problem: null,
                };
            }
            if (allowTry && ts.isTryStatement(stmt)) {
                // The try block runs first; anything after it runs later.
                return scan(stmt.tryBlock.statements, false) ?? fail('the try block holds no top-level gate');
            }
            if (doesWork(stmt, syncPrelude)) return fail(`work before the gate: \`${stmt.getText().slice(0, 80)}\``);
        }
        return null;
    };
    return scan(body.statements, true) ?? fail('no top-level gate');
}

function parseFile(full: string): ts.SourceFile {
    return ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

const parse = (rel: string) => parseFile(join(API_DIR, rel));

const handlerCases = files.flatMap((rel) => findHandlers(parse(rel)).map((h) => ({ rel, name: h.name })));

// Env-credential side effects → the exact gate each one must use. `file` is
// relative to the repo root; `name` is the HTTP method or server-action export.
// WhatsApp sends gate on requireWhatsAppIntegration() (strict session, then the
// org's own credentials; Fase 2 task 2.2b).
const WA: string[] = [];
// Server actions validate their arguments synchronously first (`syncPrelude`).
const ENV_INTEGRATION: Record<
    string,
    { file: string; name: string; gate: string; args: string[]; syncPrelude?: boolean }
> = {
    'POST /api/chat/send': { file: 'app/api/chat/send/route.ts', name: 'POST', gate: 'requireWhatsAppIntegration', args: WA },
    'POST /api/chat/send-media': {
        file: 'app/api/chat/send-media/route.ts',
        name: 'POST',
        gate: 'requireWhatsAppIntegration',
        args: WA,
    },
    'POST /api/chat/send-template': {
        file: 'app/api/chat/send-template/route.ts',
        name: 'POST',
        gate: 'requireWhatsAppIntegration',
        args: WA,
    },
    'GET /api/chat/templates': { file: 'app/api/chat/templates/route.ts', name: 'GET', gate: 'requireWhatsAppIntegration', args: WA },
    'GET /api/meetings/zoom-check': {
        file: 'app/api/meetings/zoom-check/route.ts',
        name: 'GET',
        gate: 'requireEnvIntegration',
        args: ["'zoom'"],
    },
    'POST /api/proposals/[phone] (email)': {
        file: 'app/api/proposals/[phone]/route.ts',
        name: 'POST',
        gate: 'requireEnvIntegration',
        args: ["'email'"],
    },
    // Proposal documents carry Sailendra's identity: default org only (D8, D26).
    'POST /api/proposals/[phone]/upload': {
        file: 'app/api/proposals/[phone]/upload/route.ts',
        name: 'POST',
        gate: 'requireEnvIntegration',
        args: ["'proposals'"],
    },
    'GET /api/proposals/[phone]/preview': {
        file: 'app/api/proposals/[phone]/preview/route.ts',
        name: 'GET',
        gate: 'requireEnvIntegration',
        args: ["'proposals'"],
    },
    'POST /api/proposals/[phone]/fna-summary': {
        file: 'app/api/proposals/[phone]/fna-summary/route.ts',
        name: 'POST',
        gate: 'requireEnvIntegration',
        args: ["'proposals'"],
    },
    // Sends customer WhatsApp (the org's own number) on paid / cancelled. The
    // status change itself is tenant data, so it gates on the strict org
    // context and resolves the credentials only for the notification.
    'action updateOrderStatus': {
        file: 'app/dashboard/orders/actions.ts',
        name: 'updateOrderStatus',
        gate: 'requireOrgContext',
        args: ['{ strict: true }'],
        syncPrelude: true,
    },
};

describe('API route auth coverage', () => {
    it('finds the API routes', () => {
        expect(files.length).toBeGreaterThan(25);
        expect(handlerCases.length).toBeGreaterThanOrEqual(files.length);
    });

    it.each(files)('%s exports at least one handler and no legacy session plumbing', (rel) => {
        const source = parse(rel);
        expect(findHandlers(source).length).toBeGreaterThan(0);
        expect(source.text).not.toMatch(/auth\.getUser\(|getCurrentOrgId\(|requireOrgMember\(/);
    });

    it.each(handlerCases)('$rel $name checks a gate before anything else', ({ rel, name }) => {
        const handler = findHandlers(parse(rel)).find((h) => h.name === name)!;
        const result = checkGate(handler);
        expect(result.problem, `${rel} ${name}`).toBeNull();
        expect(result.gate).not.toBeNull();
    });
});

describe('env-integration side effects use the strict gate', () => {
    const cases = Object.entries(ENV_INTEGRATION).map(([label, c]) => ({ label, ...c }));

    it.each(cases)('$label → $gate', ({ file, name, gate, args, syncPrelude }) => {
        const [handler] = findHandlers(parseFile(join(process.cwd(), file)), new Set([name]));
        expect(handler, `${file} exports ${name}`).toBeDefined();
        const result = checkGate(handler, syncPrelude);
        expect(result.problem, `${file} ${name}`).toBeNull();
        expect({ gate: result.gate, args: result.args }).toEqual({ gate, args });
    });

    it('every API route that uses requireEnvIntegration or requireWhatsAppIntegration is pinned above', () => {
        const pinned = new Set(cases.map((c) => c.file));
        const unpinned = files
            .filter((rel) => /require(Env|WhatsApp)Integration\(/.test(parse(rel).text))
            .map((rel) => `app/api/${rel}`)
            .filter((file) => !pinned.has(file));
        expect(unpinned).toEqual([]);
    });
});

describe('route-auth-coverage self-check', () => {
    const check = (code: string) =>
        findHandlers(ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)).map(
            (h) => [h.name, checkGate(h).gate] as const
        );

    it('flags an ungated handler even when a sibling handler is gated', () => {
        expect(
            check(`
                export async function GET() { const a = await requireOrgContext(); if (!a.ok) return a; return a; }
                export async function POST(req: Request) { const b = await req.json(); return b; }
            `)
        ).toEqual([
            ['GET', 'requireOrgContext'],
            ['POST', null],
        ]);
    });

    it('flags a gate that runs after other work, and accepts gates inside try / arrow handlers', () => {
        expect(
            check(`
                export async function GET(req: Request) { await req.json(); const a = await requireOrgContext(); if (!a.ok) return a; }
                export async function POST() { let x; try { const a = await requireEnvIntegration('zoom'); if (!a.ok) { return a; } } catch {} }
                export const DELETE = async () => { const fn = async () => { await other(); }; const a = await requireUserContext(); if (!a.ok) return a; };
            `)
        ).toEqual([
            ['GET', null],
            ['POST', 'requireEnvIntegration'],
            ['DELETE', 'requireUserContext'],
        ]);
    });

    it('flags an unchecked gate result and a gate inside a conditional', () => {
        expect(
            check(`
                export async function GET() { await requireOrgContext(); return work(); }
                export async function POST() { const a = await requireOrgContext(); return work(a); }
                export async function PUT(x: boolean) { if (x) { const a = await requireOrgContext(); if (!a.ok) return a; } return work(); }
                export async function PATCH() { const a = await requireOrgContext(); if (a.ok) return work(); }
            `)
        ).toEqual([
            ['GET', null],
            ['POST', null],
            ['PUT', null],
            ['PATCH', null],
        ]);
    });

    it('flags un-awaited side effects before the gate', () => {
        expect(
            check(`
                export async function GET() { fetch('https://x'); const a = await requireOrgContext(); if (!a.ok) return a; }
                export async function POST(req: Request) { req.json().then(send); const a = await requireOrgContext(); if (!a.ok) return a; }
                export async function PUT() { const p = notify(); const a = await requireOrgContext(); if (!a.ok) return a; }
            `)
        ).toEqual([
            ['GET', null],
            ['POST', null],
            ['PUT', null],
        ]);
    });

    it('refuses handlers that cannot be checked (wrapped, re-exported)', () => {
        expect(
            check(`
                async function h() { const a = await requireOrgContext(); if (!a.ok) return a; }
                export const GET = wrap(h);
                export { h as POST };
                export * from './other';
            `)
        ).toEqual([
            ['GET', null],
            ['POST', null],
            ['*', null],
        ]);
    });
});
