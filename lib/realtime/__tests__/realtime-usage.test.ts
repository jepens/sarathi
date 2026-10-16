import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Structural guard (tracker 1.9, audit KEA-15): live updates come only from
// the tab's ONE private org channel.
//   - Postgres Changes cannot isolate tenants (realtime.apply_rls sends the
//     key columns of every DELETE to every subscriber, of any org) and the
//     contract migration 0068 empties the supabase_realtime publication, so
//     no source may subscribe to it any more.
//   - supabase.channel() returns the already-open channel for a repeated
//     topic, so a second owner of a channel would share, and could remove,
//     the provider's; a component-owned channel would also put its own topic
//     (formerly with a customer phone number) on the socket. Only the
//     provider calls `.channel(`; views use useOrgRealtime / useOrgRefetch.

const ROOT = process.cwd();
const PROVIDER = 'components/realtime/org-realtime-provider.tsx';
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST = /\.test\.(ts|tsx|js|jsx)$/;

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(full);
        }
        return SOURCE.test(name) && !TEST.test(name) ? [full] : [];
    });
}

// The app's source folders (hooks/ is the shadcn alias '@/hooks') and the
// root-level files (proxy.ts, configs).
const rootFiles = readdirSync(ROOT)
    .filter((name) => SOURCE.test(name) && !TEST.test(name) && statSync(join(ROOT, name)).isFile())
    .map((name) => join(ROOT, name));
const files = ['app', 'components', 'lib', 'hooks']
    .filter((dir) => existsSync(join(ROOT, dir)))
    .flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .concat(rootFiles)
    .map((full) => relative(ROOT, full).split(sep).join('/'))
    .sort();

const containing = (needle: string) => files.filter((rel) => readFileSync(join(ROOT, rel), 'utf8').includes(needle));

describe('Realtime usage', () => {
    it('scans the app, component, hook and library sources and the root-level files', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(files).toContain(PROVIDER);
        expect(files).toContain('proxy.ts');
    });

    it('no source subscribes to postgres_changes', () => {
        expect(containing('postgres_changes')).toEqual([]);
    });

    it('only the org realtime provider opens a channel', () => {
        expect(containing('.channel(')).toEqual([PROVIDER]);
    });
});
