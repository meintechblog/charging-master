---
status: awaiting_human_verify
trigger: "The 'Neu anlernen' button next to a device profile's reference curve routes to new-device flow instead of re-recording the reference curve for the existing profile."
created: 2026-04-10T00:00:00Z
updated: 2026-04-10T08:45:00Z
---

## Current Focus

hypothesis: CONFIRMED — LearnContent guard at src/app/profiles/learn/page.tsx:156 ignored profileId, and the wizard then started on its empty profile form.
test: Code-read verification + TypeScript noEmit + charging unit tests.
expecting: Fix restores re-learn flow: click "Neu anlernen" -> wizard opens at step 2 (plug selection) with a banner naming the existing profile; backend save overwrites the existing curve for the same profileId.
next_action: Awaiting user to click "Neu anlernen" on an existing profile and confirm the flow now updates the curve in place.

## Symptoms

expected: Clicking "Neu anlernen" on an existing device profile (next to its reference curve) should start a flow that records a fresh reference curve and replaces the old curve on that SAME profile — same device ID, same name, same history. Only the reference curve data should change.
actual: Clicking "Neu anlernen" only allows the user to learn a NEW device from scratch. There is no way to keep the existing profile and just replace its reference curve, so the user had to re-learn the iPad profile as a fresh device.
errors: None reported — behavioral/flow bug.
reproduction: |
  1. Open an existing device profile (e.g. iPad) that already has a reference curve.
  2. Click the "Neu anlernen" button next to the reference curve.
  3. Observe: the UI goes into "learn new device" mode instead of "replace curve for this profile".
started: Likely since the re-learn button was added.

## Eliminated

## Evidence

- checked: src/app/profiles/[id]/page.tsx lines 449-477
  found: "Neu anlernen" button is an <a href={`/profiles/learn?profileId=${profile.id}`}>; it passes the existing profileId in the querystring.
  implication: The intent is clearly to re-learn for the existing profile, not to create a new one.

- checked: src/app/profiles/learn/page.tsx lines 149-175 (LearnContent)
  found: Reads plugId, profileId, isNew from searchParams. But the guard on line 156 is `if (plugId || isNew)` — profileId is NOT in the condition. With only `?profileId=123`, neither branch is true, so LearnOverview is rendered instead of LearnWizard. The profileId is silently ignored.
  implication: This is the primary bug. The user never even reaches the wizard.

- checked: src/components/charging/learn-wizard.tsx lines 49-63, 227-257
  found: LearnWizard already accepts `initialProfileId` and sets `createdProfileId` from it. handleProfileSubmit skips the POST /api/profiles when createdProfileId is already set. So the wizard logic already supports "re-learn for existing profile" — but it starts at step 1 which shows an EMPTY ProfileForm, which is confusing and looks like "new device".
  implication: Even after fixing the routing guard, the wizard should skip step 1 when initialProfileId is provided and jump straight to plug selection (step 2), since we already know which profile we're working with.

- checked: src/app/api/charging/learn/stop/route.ts lines 162-186
  found: The save path explicitly deletes any existing reference_curves for the profileId before inserting the new curve: "Delete any existing reference curve for this profile (re-learn overwrites)". New curve is then inserted for the same profileId.
  implication: Backend already supports the relearn semantics. The device profile row is preserved; only the curve is replaced. No schema or API changes needed — just the UI routing fix.

- checked: src/app/api/charging/learn/start/route.ts lines 32-62
  found: POST /start validates that profileId exists, then creates a new chargeSessions row linked to that profileId with state='learning'. Does not touch the profile row itself.
  implication: Relearn against existing profileId is fully supported at the start endpoint.

## Resolution

root_cause: |
  Two-part bug in the UI routing for re-learning an existing profile, both in src/app/profiles/learn/page.tsx (and one in the wizard's initial-step logic):

  1. PRIMARY: The LearnContent guard at line 156 only opens the wizard when `plugId || isNew`. The profileId query param from "Neu anlernen" is read into a variable (line 152) but never included in the guard, so the user lands on the LearnOverview instead of the wizard. They then click "Neuer Lernvorgang" and are taken to `?new=1` which starts a completely fresh profile creation — hence the user's experience of having to "learn a new device from scratch".

  2. SECONDARY: Even when entered with a valid initialProfileId, the LearnWizard starts at step 1, which renders an empty ProfileForm. The wizard's handleProfileSubmit does avoid re-creating the profile (because `createdProfileId` is already set), but showing an empty form first is misleading UX that reinforces the "new device" perception. The wizard should jump directly to step 2 (plug selection) when initialProfileId is provided.

  The backend (POST /api/charging/learn/start and POST /api/charging/learn/stop with action=save) already correctly handles re-learn: start reuses the existing profileId, and stop explicitly deletes any existing reference_curves for that profileId before inserting the new one. No DB or API changes are needed.

fix: |
  1. src/app/profiles/learn/page.tsx — Added `profileId` to the LearnContent routing guard so `/profiles/learn?profileId=N` now opens the wizard (previously only `plugId` or `new=1` did). Updated the explanatory comment.

  2. src/components/charging/learn-wizard.tsx — Introduced an `isRelearn` flag (`!!initialProfileId && !initialPlugId`) and:
     - Initialized `step` to 2 instead of 1 when in re-learn mode, so the user sees plug selection directly instead of an empty profile form.
     - Added a useEffect that preloads profile data via loadProfileData() when isRelearn, so the UI knows which profile is being re-learned.
     - Added a yellow banner ("Referenzkurve für „<name>" neu aufnehmen — Das bestehende Profil bleibt erhalten, nur die Referenzkurve wird ersetzt.") visible during steps 1–3 when in re-learn mode.
     - Changed step 2's "Zurück" button in re-learn mode to "Abbrechen" and route it back to `/profiles/<id>` instead of setStep(1), because there is no step 1 to return to.

  No DB, schema, or API changes were needed — the backend (POST /api/charging/learn/start and POST /api/charging/learn/stop action=save) already supports relearn: the stop handler explicitly deletes existing reference_curves for the profileId before inserting the new one (see stop/route.ts lines 162-186).

verification: |
  Code-level verification (done):
  - `npx tsc --noEmit` has no errors in the two changed files. Only pre-existing stale `.next/types` errors referencing a deleted MQTT route remain — unrelated to this fix.
  - `pnpm vitest run src/modules/charging` → 3 files, 28 tests passed (dtw, soc-estimator, charge-state-machine). Nothing downstream broken.
  - `pnpm lint` cannot run: project-level ESLint 10 config is missing (`eslint.config.js`). Pre-existing repo issue, unrelated to this fix.
  - Wizard resume-via-initialPlugId path is unaffected: `isRelearn = !!initialProfileId && !initialPlugId`, so when initialPlugId is present the wizard still follows the existing "resume active session, jump to step 4" path in the checkActive effect (line 107+).
  - Wizard `new=1` path is unaffected: isRelearn is false, step stays at 1, and the profile form renders as before.

  Backend relearn semantics (re-verified in code):
  - POST /api/charging/learn/start only validates the profile exists and creates a new charge_sessions row linked to that profileId. It does not touch the profile itself.
  - POST /api/charging/learn/stop with action=save: lines 162-171 delete every reference_curves row for the current profileId, then insert the new curve for that same profileId. Reference curve points and SOC boundaries cascade off the new curveId. The device_profiles row, its id, and its name/metadata are preserved.

  Human verification still needed — see CHECKPOINT REACHED below.

files_changed:
  - src/app/profiles/learn/page.tsx
  - src/components/charging/learn-wizard.tsx
