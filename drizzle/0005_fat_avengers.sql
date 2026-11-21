ALTER TABLE `repos` ADD `triage_since` integer;--> statement-breakpoint
ALTER TABLE `triage_records` ADD `suggested_at` integer;--> statement-breakpoint
ALTER TABLE `triage_records` ADD `suggest_comment_url` text;--> statement-breakpoint
ALTER TABLE `triage_records` ADD `suggest_error` text;--> statement-breakpoint
ALTER TABLE `triage_records` ADD `label_removed_at` integer;