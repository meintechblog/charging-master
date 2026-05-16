-- v1.6: replace single-profile pin with multi-profile whitelist.
-- pinnedProfileId (integer FK) → allowedProfileIds (TEXT, JSON array).
-- Existing data: v1.5 was deployed <24h ago with no UI exposure outside
-- /devices, so the production DB holds zero non-NULL pinnedProfileId rows.
-- We still UPDATE-MIGRATE any stragglers into the new column before dropping
-- the old one — single-pin becomes a length-1 JSON array, semantically
-- identical at runtime.

ALTER TABLE `plugs` ADD `allowed_profile_ids` TEXT;
UPDATE `plugs`
  SET `allowed_profile_ids` = '[' || `pinned_profile_id` || ']'
  WHERE `pinned_profile_id` IS NOT NULL;
ALTER TABLE `plugs` DROP COLUMN `pinned_profile_id`;
