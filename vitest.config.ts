import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Vitest runs the Node-side library logic (the WhatsApp queue pipeline) in
// isolation from Next.js / Turbopack. vite-tsconfig-paths resolves the `@/*`
// alias from tsconfig so tests import modules exactly as the app does.
// scripts/**: the pure helpers of one-off scripts (scripts/lib/*.mjs).
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: 'node',
        include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'scripts/**/*.test.ts'],
        globals: false,
    },
});
