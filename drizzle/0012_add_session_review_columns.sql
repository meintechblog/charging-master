-- v1.7-C: post-cycle self-calibration columns.
-- After a session reaches a terminal state, runPostCycleCalibration scores
-- delivered_wh against the committed profile and the rest of the plug's
-- whitelist. `verified_at` (epoch ms) marks "self-test passed"; `flag_reason`
-- (short German string) flags discrepancies for dashboard surfacing.
ALTER TABLE `charge_sessions` ADD `verified_at` integer;--> statement-breakpoint
ALTER TABLE `charge_sessions` ADD `flag_reason` text;
