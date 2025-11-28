Commit: fix: Remove redundant npm ci from build phase 
##########################################
### Download Github Archive Started...
### Fri, 28 Nov 2025 21:16:47 GMT
##########################################


╔═════ Nixpacks v1.34.1 ═════╗
║ setup      │ nodejs_20     ║
║────────────────────────────║
║ install    │ npm ci        ║
║────────────────────────────║
║ build      │ npm run build ║
║────────────────────────────║
║ start      │ npm start     ║
╚════════════════════════════╝


Saved output to:
  /etc/easypanel/projects/apk_web/sahabat_umkm/code/
#0 building with "default" instance using docker driver

#1 [internal] load build definition from Dockerfile
#1 transferring dockerfile: 1.75kB done
#1 DONE 0.0s

#2 [internal] load metadata for ghcr.io/railwayapp/nixpacks:ubuntu-1741046653
#2 DONE 0.5s

#3 [internal] load .dockerignore
#3 transferring context: 2B done
#3 DONE 0.0s

#4 [stage-0  1/10] FROM ghcr.io/railwayapp/nixpacks:ubuntu-1741046653@sha256:ed406b77fb751927991b8655e76c33a4521c4957c2afeab293be7c63c2a373d2
#4 DONE 0.0s

#5 [internal] load build context
#5 transferring context: 723.21kB 0.0s done
#5 DONE 0.0s

#6 [stage-0  2/10] WORKDIR /app/
#6 CACHED

#7 [stage-0  3/10] COPY .nixpacks/nixpkgs-ffeebf0acf3ae8b29f8c7049cd911b9636efd7e7.nix .nixpacks/nixpkgs-ffeebf0acf3ae8b29f8c7049cd911b9636efd7e7.nix
#7 CACHED

#8 [stage-0  4/10] RUN nix-env -if .nixpacks/nixpkgs-ffeebf0acf3ae8b29f8c7049cd911b9636efd7e7.nix && nix-collect-garbage -d
#8 CACHED

#9 [stage-0  5/10] COPY . /app/.
#9 DONE 0.0s

#10 [stage-0  6/10] RUN --mount=type=cache,id=Rti98PqCyuE-/root/npm,target=/root/.npm npm ci
#10 6.014 npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
#10 13.78 
#10 13.78 added 467 packages, and audited 468 packages in 14s
#10 13.78 
#10 13.78 161 packages are looking for funding
#10 13.78   run `npm fund` for details
#10 13.78 
#10 13.78 found 0 vulnerabilities
#10 DONE 14.9s

#11 [stage-0  7/10] COPY . /app/.
#11 DONE 0.2s

#12 [stage-0  8/10] RUN --mount=type=cache,id=Rti98PqCyuE-next/cache,target=/app/.next/cache --mount=type=cache,id=Rti98PqCyuE-node_modules/cache,target=/app/node_modules/.cache npm run build
#12 0.765 
#12 0.765 > sahabat-umkm@0.1.0 build
#12 0.765 > next build
#12 0.765 
#12 1.075 [baseline-browser-mapping] The data in this module is over two months old.  To ensure accurate Baseline data, please update: `npm i baseline-browser-mapping@latest -D`
#12 1.811 Attention: Next.js now collects completely anonymous telemetry regarding usage.
#12 1.811 This information is used to shape Next.js' roadmap and prioritize features.
#12 1.811 You can learn more, including how to opt-out if you'd not like to participate in this anonymous program, by visiting the following URL:
#12 1.811 https://nextjs.org/telemetry
#12 1.811 
#12 1.829    ▲ Next.js 16.0.5 (Turbopack)
#12 1.830    - Environments: .env
#12 1.830 
#12 1.869  ⚠ The "middleware" file convention is deprecated. Please use "proxy" instead. Learn more: https://nextjs.org/docs/messages/middleware-to-proxy
#12 1.903    Creating an optimized production build ...
#12 2.058 [baseline-browser-mapping] The data in this module is over two months old.  To ensure accurate Baseline data, please update: `npm i baseline-browser-mapping@latest -D`
#12 4.375 [baseline-browser-mapping] The data in this module is over two months old.  To ensure accurate Baseline data, please update: `npm i baseline-browser-mapping@latest -D`
#12 10.17  ✓ Compiled successfully in 7.7s
#12 10.19    Running TypeScript ...
#12 14.66 Failed to compile.
#12 14.66 
#12 14.66 ./scripts/test-shipping-service.ts:8:58
#12 14.66 Type error: Cannot find module '../lib/shipping/komerce' or its corresponding type declarations.
#12 14.66 
#12 14.66    6 | dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
#12 14.66    7 |
#12 14.66 >  8 | import { searchDestination, calculateShippingCost } from '../lib/shipping/komerce';
#12 14.66      |                                                          ^
#12 14.66    9 |
#12 14.66   10 | async function test() {
#12 14.66   11 |     console.log('Testing Shipping Service...');
#12 14.74 Next.js build worker exited with code: 1 and signal: null
#12 14.80 npm notice
#12 14.80 npm notice New major version of npm available! 10.8.2 -> 11.6.4
#12 14.80 npm notice Changelog: https://github.com/npm/cli/releases/tag/v11.6.4
#12 14.80 npm notice To update run: npm install -g npm@11.6.4
#12 14.80 npm notice
#12 ERROR: process "/bin/bash -ol pipefail -c npm run build" did not complete successfully: exit code: 1
------
 > [stage-0  8/10] RUN --mount=type=cache,id=Rti98PqCyuE-next/cache,target=/app/.next/cache --mount=type=cache,id=Rti98PqCyuE-node_modules/cache,target=/app/node_modules/.cache npm run build:
14.66      |                                                          ^
14.66    9 |
14.66   10 | async function test() {
14.66   11 |     console.log('Testing Shipping Service...');
14.74 Next.js build worker exited with code: 1 and signal: null
14.80 npm notice
14.80 npm notice New major version of npm available! 10.8.2 -> 11.6.4
14.80 npm notice Changelog: https://github.com/npm/cli/releases/tag/v11.6.4
14.80 npm notice To update run: npm install -g npm@11.6.4
14.80 npm notice
------

 13 warnings found (use docker --debug to expand):
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ARG "WHATSAPP_ACCESS_TOKEN") (line 11)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ENV "SHIPPING_COST_KOMERCE_API_KEY") (line 12)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ENV "SHIPPING_DELIVERY_KOMERCE_API_KEY") (line 12)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ENV "WHATSAPP_ACCESS_TOKEN") (line 12)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ENV "WHATSAPP_APP_SECRET") (line 12)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ARG "SHIPPING_COST_KOMERCE_API_KEY") (line 11)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ARG "SHIPPING_DELIVERY_KOMERCE_API_KEY") (line 11)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ARG "WHATSAPP_APP_SECRET") (line 11)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ARG "WHATSAPP_VERIFY_TOKEN") (line 11)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ENV "OPENAI_API_KEY") (line 12)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ENV "WHATSAPP_VERIFY_TOKEN") (line 12)
 - UndefinedVar: Usage of undefined variable '$NIXPACKS_PATH' (line 18)
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ARG "OPENAI_API_KEY") (line 11)
Dockerfile:24
--------------------
  22 |     # build phase
  23 |     COPY . /app/.
  24 | >>> RUN --mount=type=cache,id=Rti98PqCyuE-next/cache,target=/app/.next/cache --mount=type=cache,id=Rti98PqCyuE-node_modules/cache,target=/app/node_modules/.cache npm run build
  25 |     
  26 |     
--------------------
ERROR: failed to build: failed to solve: process "/bin/bash -ol pipefail -c npm run build" did not complete successfully: exit code: 1
##########################################
### Error
### Fri, 28 Nov 2025 21:17:18 GMT
##########################################

Command failed with exit code 1: docker buildx build --network host -f /etc/easypanel/projects/apk_web/sahabat_umkm/code/.nixpacks/Dockerfile -t easypanel/apk_web/sahabat_umkm --label 'keep=true' --build-arg 'NEXT_PUBLIC_SUPABASE_URL=https://vjdmkxcrdiuhfrflrhkq.supabase.co' --build-arg 'NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZqZG1reGNyZGl1aGZyZmxyaGtxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQyNjQ2NTUsImV4cCI6MjA3OTg0MDY1NX0.XLmsel3WU05O6AyFjBU_76HWHz-IdhzP-P4qdvLO6ec' --build-arg 'OPENAI_API_KEY=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' --build-arg 'WHATSAPP_ACCESS_TOKEN=EAAOOBFxBujMBOZBL0S4JbothWzCHzcgJRbSEwyHpaZC33eKKvuPYsFIEFcgCKfARcwCf7gkCo4cBlriFv6ZCx8xDHs0Vbnj7OcQm9Igg9ZCHxMvBby1KOWKqmoc2a8Lo9QTpO8lEIiBzj8fNNKCYZBkZCjsPfX7wzG37W8lwR3bbH2qnoe67WnzsEWwxfH1QS12wZDZD' --build-arg 'WHATSAPP_PHONE_NUMBER_ID=668003893055590' --build-arg 'WHATSAPP_VERIFY_TOKEN=123456' --build-arg 'WHATSAPP_APP_SECRET=1aafe59a62fbda1e0adefd1d8f96bf9a' --build-arg 'SHIPPING_COST_KOMERCE_API_KEY=0KutCiCz396b710cc2de0138th7k3kDe' --build-arg 'SHIPPING_DELIVERY_KOMERCE_API_KEY=Mk8ypNeW396b710cc2de0138RL7SyS24' --build-arg 'GIT_SHA=db8b856f26ef10dbeca3ac9938c37cf219b0f750' /etc/easypanel/projects/apk_web/sahabat_umkm/code/