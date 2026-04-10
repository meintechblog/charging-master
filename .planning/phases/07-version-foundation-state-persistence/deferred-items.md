# Deferred Items — Phase 7

Items discovered during Phase 7 execution that are out of scope for the
current plan. Not fixed here to respect plan boundaries.

## 07-01

### Stale `.next/types/` references to deleted MQTT routes

- **Found during:** Task 3 `tsc --noEmit` verification
- **Symptoms:** `tsc --noEmit` reports 6 errors in `.next/types/app/api/mqtt/status/route.ts`,
  `.next/types/app/api/mqtt/test/route.ts`, `.next/types/validator.ts` pointing to
  `src/app/api/mqtt/*/route.js` modules that no longer exist.
- **Root cause:** Phase 6 removed `src/app/api/mqtt/*` routes, but the `.next/types/`
  generated directory still has leftover stubs from a prior build. Running
  `pnpm build` (which wipes `.next` first) or `rm -rf .next` would clear these.
- **Why deferred:** Pre-existing issue, not introduced by 07-01. Zero impact on
  self-update or version.ts — the plan's verify command specifically excludes
  these paths via `(! grep -E 'self-update|version\.ts')` and passes.
- **Suggested fix:** `rm -rf .next && pnpm build` once, or add a `clean` script.
  No functional impact at runtime.
