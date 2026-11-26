CREATE TABLE `plan_children` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`position` integer NOT NULL,
	`number` integer NOT NULL,
	`github_id` integer NOT NULL,
	`title` text NOT NULL,
	`linked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_children_run_position_unique` ON `plan_children` (`run_id`,`position`);--> statement-breakpoint
ALTER TABLE `pi_settings` ADD `plan_model` text;--> statement-breakpoint
ALTER TABLE `pi_settings` ADD `plan_effort` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `plan_released_at` integer;