CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`pr_number` integer,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`author_id` text NOT NULL,
	`author_login` text NOT NULL,
	`trust` text NOT NULL,
	`is_command` integer NOT NULL,
	`instruction` text,
	`body` text NOT NULL,
	`path` text,
	`line` integer,
	`review_state` text,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`run_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`seen_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_repo_source_external_unique` ON `feedback` (`repo_id`,`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `feedback_cursors` (
	`repo_id` integer NOT NULL,
	`kind` text NOT NULL,
	`cursor` integer NOT NULL,
	`started_at` integer NOT NULL,
	PRIMARY KEY(`repo_id`, `kind`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `trusted_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`login` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trusted_users_repo_user_unique` ON `trusted_users` (`repo_id`,`user_id`);