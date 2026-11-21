CREATE TABLE `triage_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`author_id` text NOT NULL,
	`author_login` text NOT NULL,
	`trust` text NOT NULL,
	`content_hash` text NOT NULL,
	`issue_updated_at` integer NOT NULL,
	`checks` text NOT NULL,
	`decision` text,
	`llm_decision` text,
	`missing` text NOT NULL,
	`note` text,
	`model` text,
	`error` text,
	`already_ready` integer NOT NULL,
	`attempts` integer NOT NULL,
	`triaged_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `triage_repo_number_hash_unique` ON `triage_records` (`repo_id`,`number`,`content_hash`);--> statement-breakpoint
ALTER TABLE `repos` ADD `triage_level` text DEFAULT 'off' NOT NULL;