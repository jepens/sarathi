import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Structural guard (KUA-14): every user-facing API route handler must go
// through the central org context — requireOrgContext(), requireEnvIntegration()
// or (session-only) requireUserContext() — instead of ad-hoc getUser() checks.
// A new route that forgets the gate fails here.
//
// Routes with their OWN authentication are exempt:
//   - webhook/whatsapp — Meta signature (X-Hub-Signature-256);
//   - queue/process    — cron bearer secret.
// (/auth/confirm lives outside app/api.)

const API_DIR = join(process.cwd(), 'app', 'api');
const EXEMPT = new Set(['webhook/whatsapp/route.ts', 'queue/process/route.ts']);

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

const GATE = /await\s+require(?:OrgContext|UserContext|EnvIntegration)\(/g;
const HANDLER = /^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/gm;

describe('API route auth coverage', () => {
    it('finds the API routes', () => {
        expect(files.length).toBeGreaterThan(25);
    });

    it.each(files)('%s gates every handler through the org context', (rel) => {
        const src = readFileSync(join(API_DIR, rel), 'utf8');
        const handlers = src.match(HANDLER) ?? [];
        const gates = src.match(GATE) ?? [];
        expect(handlers.length).toBeGreaterThan(0);
        expect(gates.length).toBeGreaterThanOrEqual(handlers.length);
        // No legacy per-route session plumbing left behind.
        expect(src).not.toMatch(/auth\.getUser\(|getCurrentOrgId\(|requireOrgMember\(/);
    });
});
