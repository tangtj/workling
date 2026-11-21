ALTER TABLE `feedback` ADD `review_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `kind` text DEFAULT 'implement' NOT NULL;