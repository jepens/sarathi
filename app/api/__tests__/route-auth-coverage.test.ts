import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

// Structural guard (KUA-14): EVERY exported user-facing API route handler must
// go through the central org context — requireOrgContext(),
// requireEnvIntegration() or (session-only) requireUserContext() — and that
// gate must be the handler's FIRST await, i.e. it runs before the body is
// parsed, data is touched or an external call is made. A new handler that
// forgets the gate (or moves it below other work) fails here.
//
// The check parses each route with the TypeScript compiler API and inspects
// each exported HTTP handler on its own (a gated GET does not cover an ungated
// POST in the same file). Awaits inside nested functions declared before the
// gate are ignored — they are not executed at that point.
//
// Routes with their OWN authentication are exempt:
//   - webhook/whatsapp — Meta signature (X-Hub-Signature-256);
//   - queue/process    — cron bearer secret.
// (/auth/confirm lives outside app/api.)

const API_DIR = join(process.cwd(), 'app', 'api');
const EXEMPT = new Set(['webhook/whatsapp/route.ts', 'queue/process/route.ts']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const GATES = new Set(['requireOrgContext', 'requireUserContext', 'requireEnvIntegration']);

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
    fn: FnBody;
}

function isExported(node: ts.Node): boolean {
    return (
        ts.canHaveModifiers(node) &&
        (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    );
}

/** Exported HTTP handlers: `export async function GET` and `export const GET = async () =>`. */
function findHandlers(source: ts.SourceFile): Handler[] {
    const handlers: Handler[] = [];
    for (const stmt of source.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt) && METHODS.has(stmt.name.text)) {
            handlers.push({ name: stmt.name.text, fn: stmt });
        }
        if (ts.isVariableStatement(stmt) && isExported(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (
                    ts.isIdentifier(decl.name) &&
                    METHODS.has(decl.name.text) &&
                    decl.initializer &&
                    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
                ) {
                    handlers.push({ name: decl.name.text, fn: decl.initializer });
                }
            }
        }
    }
    return handlers;
}

/** The first await executed in the handler body (source order, nested functions skipped). */
function firstAwait(fn: FnBody): ts.AwaitExpression | null {
    let found: ts.AwaitExpression | null = null;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isAwaitExpression(node)) {
            found = node;
            return;
        }
        if (ts.isFunctionLike(node)) return; // not executed here
        ts.forEachChild(node, visit);
    };
    if (fn.body) ts.forEachChild(fn.body, visit);
    return found;
}

/** Name of the gate the await calls, or null when it awaits something else. */
function awaitedGate(expr: ts.AwaitExpression | null): string | null {
    if (!expr || !ts.isCallExpression(expr.expression)) return null;
    const callee = expr.expression.expression;
    return ts.isIdentifier(callee) && GATES.has(callee.text) ? callee.text : null;
}

function parse(rel: string): ts.SourceFile {
    const src = readFileSync(join(API_DIR, rel), 'utf8');
    return ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

const handlerCases = files.flatMap((rel) => findHandlers(parse(rel)).map((h) => ({ rel, name: h.name })));

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

    it.each(handlerCases)('$rel $name awaits a gate before anything else', ({ rel, name }) => {
        const handler = findHandlers(parse(rel)).find((h) => h.name === name)!;
        const first = firstAwait(handler.fn);
        expect(
            awaitedGate(first),
            `${rel} ${name}: first await is ${first ? `\`${first.getText()}\`` : 'missing'}`
        ).not.toBeNull();
    });
});

describe('route-auth-coverage self-check', () => {
    const check = (code: string) =>
        findHandlers(ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)).map(
            (h) => [h.name, awaitedGate(firstAwait(h.fn))] as const
        );

    it('flags an ungated handler even when a sibling handler is gated', () => {
        expect(
            check(`
                export async function GET() { const a = await requireOrgContext(); return a; }
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
                export async function GET(req: Request) { await req.json(); await requireOrgContext(); }
                export async function POST() { try { const a = await requireEnvIntegration('zoom'); } catch {} }
                export const DELETE = async () => { const fn = async () => { await other(); }; await requireUserContext(); };
            `)
        ).toEqual([
            ['GET', null],
            ['POST', 'requireEnvIntegration'],
            ['DELETE', 'requireUserContext'],
        ]);
    });
});
