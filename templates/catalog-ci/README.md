# Catalog CI Templates

These files are setup artifacts intended to be **copied into your catalog
repository** (`<owner>/<catalog-repo-name>`), NOT consumed from this
repo. They live here so they version-control alongside the app code that
opens the PRs they validate.

## Files

| Source                                | Destination in catalog repo                          |
| ------------------------------------- | ---------------------------------------------------- |
| `validate-catalog-submission.yml`     | `.github/workflows/validate-catalog-submission.yml`  |
| `validate-catalog.mjs`                | `.github/scripts/validate-catalog.mjs`               |

## What they do

Triggered on every Pull Request opened by the charging-master auto-sync
against `submissions/**` branches. The workflow:

1. Enforces the path allowlist — only `catalog/profiles/**`,
   `catalog/chargers/**`, and `catalog/INDEX.json` may change.
2. Rejects image files larger than 2 MB.
3. Validates JSON parsability + a minimal shape check for every changed
   `.json` file (3 required fields per profile/index, 2 per charger).
4. Confirms at least one commit message in the PR starts with
   `catalog: auto-sync `.

On any failure the PR's `Validate catalog submission` check turns red
and a `::error file=…::` annotation points at the offending file.

## Manual catalog edits

Manual PRs that don't use a `submissions/**` branch skip the workflow
entirely (because of the `if: startsWith(github.head_ref, 'submissions/')`
guard). You can edit `catalog/` files via a regular feature branch
without the auto-sync CI complaining.

## Updating

After modifying templates here, copy them again to your catalog repo.
The catalog repo is the source-of-truth for what actually runs on PRs;
this repo just keeps them version-controlled next to the code that
relies on them.

## Schema validation depth

The current `validate-catalog.mjs` is intentionally minimal — it checks
that each JSON file is parsable and has a small set of required
top-level fields. A full zod-schema sync from the app (export
`catalog-schema.json` as a release asset, vendor it into the catalog
repo, swap the hand-rolled check for `ajv` or generated zod) is a
follow-up backlog item. For now the upstream guarantee is the same: PRs
always originate from `buildPublishBundle`, which already zod-validates
on the server before pushing.

See `../../docs/CATALOG_AUTOSYNC.md` for the full setup walkthrough.
