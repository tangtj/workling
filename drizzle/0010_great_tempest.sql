CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`delivery_run_id` integer NOT NULL,
	`pr_url` text NOT NULL,
	`branch` text NOT NULL,
	`head_sha` text NOT NULL,
	`partial` integer NOT NULL,
	`status` text NOT NULL,
	`run_id` integer,
	`model` text,
	`effort` text,
	`verdict` text,
	`summary` text,
	`checks` text,
	`acceptance` text,
	`findings` text,
	`error` text,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_delivery_run_unique` ON `reviews` (`delivery_run_id`);--> statement-breakpoint
ALTER TABLE `pi_settings` ADD `review_model` text;--> statement-breakpoint
ALTER TABLE `pi_settings` ADD `review_effort` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `review_level` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `review_since` integer;