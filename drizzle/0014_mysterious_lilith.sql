-- Phase 14: PR-flow auto-sync — track the GitHub PR URL per sync attempt.
-- NULL for legacy rows (pre-v2 PAT direct-push) and for skipped/error rows.
ALTER TABLE `catalog_sync_log` ADD `pr_url` text;
