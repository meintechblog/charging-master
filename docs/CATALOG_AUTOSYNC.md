# Catalog Auto-Sync — Setup Guide

This guide walks through configuring the catalog auto-sync feature so that
edits to profiles, chargers, photos, and reference curves on this LXC
automatically appear as Pull Requests in your catalog repository — without
a long-lived Personal Access Token on the box.

## Why?

The original v1 implementation (commit `700e6eb`) used a GitHub PAT with
`contents:write` scope stored in the local database
(`github.contentsToken` config row). That gave the LXC the equivalent of a
logged-in maintainer — a token leak from the LXC would have let an
attacker push arbitrary code to the maintainer's repos. After the
2026-05-20 review the feature was parked.

The v2 design replaces the PAT with a **GitHub App**:

- The App holds an RSA private key on the LXC, chmod 600.
- Each publish cycle mints a fresh **installation access token** (~1h
  TTL) by signing a short-lived JWT (RS256, ≤10 min) and posting it to
  `/app/installations/{id}/access_tokens`. The token is held in memory
  for the duration of one publish operation only — never persisted.
- The token's scope is the **single catalog repository** only, not the
  maintainer's whole account.
- **Branch protection** on the catalog repo's `main` enforces that every
  change goes through a Pull Request. The LXC code path never attempts
  a direct push, so a stolen token can only open PRs — not merge them.

## Architecture

```
[Profile edit / photo upload]
        │
        ▼
[scheduleCatalogSync(profileId, reason)]
        │
        ▼ (15s debounce, circuit-broken on 3 consecutive failures)
[runSyncOnce → mint installation-token]
        │
        ▼
[create branch submissions/<slug>-<unix-ms>]
        │
        ▼
[commit artifacts via Data API (blobs → tree → commit → ref)]
        │
        ▼
[open PR → label 'auto-sync']
        │
        ▼
[CI: validate-catalog-submission.yml runs]
        │
        ▼
[Hulki reviews + merges manually]
```

## Step 1 — Register the GitHub App

1. Open <https://github.com/settings/apps> → **New GitHub App**.
2. **GitHub App name:** `charging-master-catalog-<your-handle>` (must be
   globally unique across GitHub).
3. **Homepage URL:** anything — your blog or the catalog repo URL is
   fine; it's not load-bearing.
4. **Webhook:** uncheck "Active". This App is publish-only — we don't
   consume any events.
5. **Repository permissions:**
   - **Contents:** Read & write
   - **Pull requests:** Read & write
   - **Metadata:** Read-only (auto-required)
   - All others: No access
6. **Where can this App be installed?** "Only on this account".
7. Click **Create GitHub App**.
8. Note the **App ID** shown at the top of the App settings page — you
   will need it for env vars in Step 5.

## Step 2 — Generate and store the private key

1. On the App settings page, scroll to **Private keys** → click
   **Generate a private key**.
2. A `.pem` file downloads. Rename it to `github-app.pem`.
3. SCP it to the LXC under a protected directory and lock the permissions:
   ```bash
   ssh root@charging-master.local 'mkdir -p /opt/charging-master/secrets'
   scp github-app.pem root@charging-master.local:/opt/charging-master/secrets/github-app.pem
   ssh root@charging-master.local 'chmod 600 /opt/charging-master/secrets/github-app.pem && chown root:root /opt/charging-master/secrets/github-app.pem'
   ```
4. Verify:
   ```bash
   ssh root@charging-master.local 'ls -la /opt/charging-master/secrets/github-app.pem'
   # expected: -rw------- 1 root root <size> ... github-app.pem
   ```

## Step 3 — Install the App on your catalog repo

1. On the App settings page, click **Install App** in the left sidebar.
2. Click **Install** next to your account.
3. Choose **Only select repositories** and pick your catalog repo
   (e.g. `meintechblog/charging-master-catalog`).
4. Confirm. You land on a URL like
   `https://github.com/settings/installations/<installation-id>` — note
   that **Installation ID** number. You will need it for env vars in
   Step 5.

## Step 4 — Configure Branch Protection on `main`

Open the catalog repo → **Settings** → **Branches** → **Branch protection
rules** → **Add rule** (or **Add branch ruleset** in the newer UI).

- **Branch name pattern:** `main`
- **Require a pull request before merging:** ✓
  - **Require approvals:** 1 (a sanity-pause even for solo use; can be
    0 if you trust the CI to catch everything).
- **Require status checks to pass before merging:** ✓
  - After Step 6 you will come back and select
    `Validate catalog submission` here — it must run at least once on a
    PR to be selectable.
- **Do not allow bypassing the above settings:** ✓
- **Restrict who can push to matching branches:** ✓ — only maintainers.
  The GitHub App is implicitly excluded (it has no push privileges,
  only PR-open).
- **Do not allow force pushes:** ✓
- Save.

## Step 5 — Wire env vars into the systemd unit

Edit (or create) `/etc/systemd/system/charging-master.service.d/override.conf`:

```ini
[Service]
Environment=GITHUB_APP_ID=<your-app-id>
Environment=GITHUB_APP_INSTALLATION_ID=<your-installation-id>
Environment=GITHUB_APP_PRIVATE_KEY_PATH=/opt/charging-master/secrets/github-app.pem
Environment=CATALOG_REPO_OWNER=<your-github-user-or-org>
Environment=CATALOG_REPO_NAME=<your-catalog-repo-name>
```

**Alternative**: paste the PEM literally into
`GITHUB_APP_PRIVATE_KEY=` instead of `GITHUB_APP_PRIVATE_KEY_PATH=`
(multi-line via systemd escape). Pick **exactly one** of the two — both
set, or both unset, is a config error and `isAutoSyncEnabled()` will
refuse to fire with a `disabledReason` of
`'exactly one of GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH
must be set'`.

Apply:

```bash
systemctl daemon-reload
systemctl restart charging-master
```

Verify:

```bash
curl -s http://charging-master.local/api/catalog/sync-status | jq '.tokenConfigured, .disabledReason'
# Expected: true / null
```

If `tokenConfigured` is false, the `disabledReason` string tells you
exactly which env var is wrong — see Troubleshooting below.

## Step 6 — Install the CI workflow in the catalog repo

Two files live in this repo under `templates/catalog-ci/` and need to be
copied into the catalog repo:

| Source                                                | Destination                                              |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `templates/catalog-ci/validate-catalog-submission.yml` | `.github/workflows/validate-catalog-submission.yml`     |
| `templates/catalog-ci/validate-catalog.mjs`            | `.github/scripts/validate-catalog.mjs`                  |

In the catalog repo working tree:

```bash
mkdir -p .github/workflows .github/scripts
cp <path-to-charging-master>/templates/catalog-ci/validate-catalog-submission.yml .github/workflows/
cp <path-to-charging-master>/templates/catalog-ci/validate-catalog.mjs .github/scripts/
git add .github/
git commit -m "ci: validate catalog submission PRs"
git push origin main
```

After the first push, open the catalog repo's
**Settings → Branches → Branch protection rule** for `main` → re-edit
it and now select `Validate catalog submission` under
**Required status checks**. (It only becomes selectable after the
workflow has run at least once.)

## Step 7 — Smoke test (Bosch PowerTube 625)

This is the end-to-end validation. It is **operator work** on the real
LXC + the real GitHub App — not something the CI here can run.

1. In the charging-master UI, open
   **Profiles → Bosch PowerTube 625** (or any other profile with a
   learned reference curve).
2. Upload a fresh product photo via the profile edit page.
3. Within ~15 seconds, a new PR appears on the catalog repo:
   - **Title:** `catalog: auto-sync photo-upload (Bosch PowerTube 625)`
   - **Branch:** `submissions/bosch-powertube-625-<unix-ms>`
   - **Label:** `auto-sync`
   - **Body:** trigger reason, sync log id, file list, machine-readable
     footer comment.
4. The `Validate catalog submission` check on the PR turns green within
   a minute.
5. Merge the PR manually.
6. After the next snapshot fetch on consumer LXCs, the new photo shows
   up at `catalog/profiles/<id>.photo.jpg`.
7. Back in the charging-master UI under **Settings → Profil-Katalog**,
   the "Letzter PR" line links to the merged PR.

## Rollback

To temporarily disable auto-sync without touching the App:

```bash
# Option A: Unset env vars (graceful — App stays installed, no syncs fire)
systemctl edit charging-master            # comment out the GITHUB_APP_* lines
systemctl restart charging-master

# Option B: Toggle off in the UI (Settings → Profil-Katalog → Auto-Sync der Profile)
#          (writes 'false' to the catalog.autoSync config row)
```

To permanently revoke access:

1. Catalog repo → **Settings** → **Integrations** → **Installed GitHub
   Apps** → click your App → **Uninstall**.
2. Verify on the next sync attempt that `/api/catalog/sync-status`
   reports `tokenConfigured: false` with a `disabledReason` like
   `installation_not_found`.

## Troubleshooting

| Symptom                                                                                                                                                       | Likely cause                                                                                  | Fix                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tokenConfigured: false` and `disabledReason: 'exactly one of GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH must be set'`                              | Both env vars set, or both empty                                                              | Pick one; unset the other; `systemctl restart charging-master`                                               |
| `disabledReason: 'github_app_private_key_unreadable: ...'`                                                                                                    | PEM file missing or wrong permissions                                                         | `ls -la /opt/charging-master/secrets/github-app.pem` — must be `-rw------- root root`                        |
| Sync log error: `github_app_auth_failed: github_app_unauthorized`                                                                                             | App ID or installation ID mismatch (or PEM doesn't belong to this App)                        | Cross-check both IDs on the App settings page; regenerate the PEM if you suspect it                          |
| Sync log error: `github_app_auth_failed: installation_not_found`                                                                                              | The App was uninstalled from the repo, or the installation ID is wrong                        | Re-install per Step 3                                                                                        |
| Sync log error: `pr_create_failed: 422 ...`                                                                                                                   | Branch protection on `main` is too strict — e.g. requires a CODEOWNERS approval the App can't satisfy | Adjust branch protection so the App can OPEN PRs without restrictions. Approvals can still be required for merge |
| PR opens but the CI check is red on `Path allowlist`                                                                                                          | A non-allowlisted file leaked into the artifact bundle                                        | Inspect the offending path in the PR; check `buildPublishBundle` for a regression                            |
| PR opens but no `auto-sync` label                                                                                                                              | The label doesn't exist in the repo and the API call to create it silently failed             | Create the `auto-sync` label manually in the catalog repo once; subsequent syncs reuse it                    |
| Toggle is on, env is configured, but no PR appears after an edit                                                                                              | Circuit breaker tripped (3 consecutive failures within 10 min)                                | Check `/api/catalog/sync-status` → `recentSyncErrors` for the underlying cause; wait 10 min, or fix and `systemctl restart` |
| `pnpm dev` boot crashes with `server-only` import error                                                                                                        | A new module reachable from `server.ts` accidentally imported `server-only`                   | See `[[feedback_server_only_with_custom_server]]` — remove the import; the existing safe-pattern files are listed there |

## See also

- `templates/catalog-ci/README.md` — what the CI templates do and how to update them.
- `docs/ios-shortcut-setup.md` — analog setup walkthrough for the iOS Shortcut SoC reporter.
- `.planning/phases/14-catalog-auto-sync-v2-github-app-pr-flow/` — design decisions, pattern map, plan-check report.
