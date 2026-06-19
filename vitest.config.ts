import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Vitest runs the Node-side library logic (the WhatsApp queue pipeline) in
// isolation from Next.js / Turbopack. vite-tsconfig-paths resolves the `@/*`
// alias from tsconfig so tests import modules exactly as the app does.
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: 'node',
        include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
        globals: false,
    },
});
