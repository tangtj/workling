import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const upgradeSteps = sqliteTable('upgrade_steps', {
  id: text('id').primaryKey(),
  description: text('description').notNull(),
  appliedAt: integer('applied_at', { mode: 'timestamp' }).notNull(),
})

export const repos = sqliteTable('repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ref: text('ref').notNull().unique(),
  platform: text('platform', { enum: ['github', 'gitlab'] }).notNull(),
  host: text('host').notNull(),
  path: text('path').notNull(),
  token: text('token').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  triageLevel: text('triage_level', { enum: ['off', 'shadow'] })
    .notNull()
    .default('off'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const admin = sqliteTable('admin', {
  id: integer('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
})

export const issues = sqliteTable(
  'issues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title'),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed', 'canceled'] }).notNull(),
    prUrl: text('pr_url'),
    prState: text('pr_state', { enum: ['open', 'merged', 'closed'] }),
    // 不设外键，避免 issues 与 runs 循环引用。
    lastRunId: integer('last_run_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [uniqueIndex('issues_repo_number_unique').on(table.repoId, table.number)],
)

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  issueId: integer('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  worker: text('worker').notNull(),
  taskDir: text('task_dir'),
  pid: integer('pid'),
  container: text('container'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
  exitCode: integer('exit_code'),
  error: text('error'),
  summary: text('summary'),
  reportResult: text('report_result'),
  logTail: text('log_tail'),
  branch: text('branch'),
  baseRef: text('base_ref'),
})

export const piSettings = sqliteTable('pi_settings', {
  id: integer('id').primaryKey(),
  model: text('model').notNull(),
  effort: text('effort', { enum: ['low', 'medium', 'high', 'xhigh'] }).notNull(),
  piModel: text('pi_model'),
  llmBaseUrl: text('llm_base_url'),
  llmApiKey: text('llm_api_key'),
  llmApi: text('llm_api', { enum: ['openai-responses', 'openai-completions'] }).notNull(),
  gitName: text('git_name').notNull(),
  gitEmail: text('git_email').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const executorSettings = sqliteTable('executor_settings', {
  id: integer('id').primaryKey(),
  sandbox: text('sandbox', { enum: ['none', 'docker'] }).notNull(),
  taskImage: text('task_image').notNull(),
  taskCpus: real('task_cpus').notNull(),
  taskMemory: text('task_memory').notNull(),
  taskPids: integer('task_pids').notNull(),
  taskNetwork: text('task_network'),
  concurrency: integer('concurrency').notNull().default(3),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const feedback = sqliteTable(
  'feedback',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number'),
    source: text('source', {
      enum: ['issue_comment', 'pr_comment', 'review_comment', 'review'],
    }).notNull(),
    externalId: text('external_id').notNull(),
    authorId: text('author_id').notNull(),
    authorLogin: text('author_login').notNull(),
    trust: text('trust', { enum: ['self', 'bot', 'allowlist', 'write', 'untrusted'] }).notNull(),
    isCommand: integer('is_command', { mode: 'boolean' }).notNull(),
    instruction: text('instruction'),
    body: text('body').notNull(),
    path: text('path'),
    line: integer('line'),
    reviewState: text('review_state'),
    url: text('url').notNull(),
    status: text('status', {
      enum: ['ignored', 'observed', 'pending', 'included', 'replied'],
    }).notNull(),
    runId: integer('run_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    seenAt: integer('seen_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    uniqueIndex('feedback_repo_source_external_unique').on(
      table.repoId,
      table.source,
      table.externalId,
    ),
  ],
)

export const feedbackCursors = sqliteTable(
  'feedback_cursors',
  {
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['issue_comments', 'review_comments'] }).notNull(),
    cursor: integer('cursor', { mode: 'timestamp' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.kind] })],
)

export const trustedUsers = sqliteTable(
  'trusted_users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    login: text('login').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [uniqueIndex('trusted_users_repo_user_unique').on(table.repoId, table.userId)],
)

export const triageRecords = sqliteTable(
  'triage_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    authorId: text('author_id').notNull(),
    authorLogin: text('author_login').notNull(),
    trust: text('trust', { enum: ['allowlist', 'write'] }).notNull(),
    contentHash: text('content_hash').notNull(),
    issueUpdatedAt: integer('issue_updated_at', { mode: 'timestamp' }).notNull(),
    checks: text('checks').notNull(),
    decision: text('decision', { enum: ['accept', 'needs_info', 'ignore'] }),
    llmDecision: text('llm_decision', { enum: ['accept', 'needs_info', 'ignore'] }),
    missing: text('missing').notNull(),
    note: text('note'),
    model: text('model'),
    error: text('error'),
    alreadyReady: integer('already_ready', { mode: 'boolean' }).notNull(),
    attempts: integer('attempts').notNull(),
    triagedAt: integer('triaged_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    uniqueIndex('triage_repo_number_hash_unique').on(table.repoId, table.number, table.contentHash),
  ],
)
