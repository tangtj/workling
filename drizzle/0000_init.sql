-- 事件：初始化数据库结构
-- 原因：首次公开发布前，把开发期的 8 个迁移合并为一个
-- 简述：创建 admin、sessions、repos、issues、runs、pi_settings、executor_settings、upgrade_steps 全部表
-- 事件: 2026-11-15
CREATE TABLE `admin` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `executor_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`sandbox` text NOT NULL,
	`task_image` text NOT NULL,
	`task_cpus` real NOT NULL,
	`task_memory` text NOT NULL,
	`task_pids` integer NOT NULL,
	`task_network` text,
	`concurrency` integer DEFAULT 3 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text,
	`status` text NOT NULL,
	`pr_url` text,
	`last_run_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_repo_number_unique` ON `issues` (`repo_id`,`number`);--> statement-breakpoint
CREATE TABLE `pi_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`pi_model` text,
	`llm_base_url` text,
	`llm_api_key` text,
	`llm_api` text NOT NULL,
	`git_name` text NOT NULL,
	`git_email` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ref` text NOT NULL,
	`platform` text NOT NULL,
	`host` text NOT NULL,
	`path` text NOT NULL,
	`token` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_ref_unique` ON `repos` (`ref`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`worker` text NOT NULL,
	`task_dir` text,
	`pid` integer,
	`container` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`exit_code` integer,
	`error` text,
	`summary` text,
	`report_result` text,
	`log_tail` text,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `upgrade_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`applied_at` integer NOT NULL
);
