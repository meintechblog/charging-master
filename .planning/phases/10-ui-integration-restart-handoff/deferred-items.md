# Deferred Items — Phase 10

## Pre-existing environment issue
- `pnpm lint` is broken at repo root: no `eslint.config.js/mjs/cjs` file exists and ESLint 9+ no longer supports `.eslintrc.*`. Not caused by this plan; Plan 10-01 SUMMARY also noted typecheck-only verification. Restoring lint is out of scope for 10-02.
