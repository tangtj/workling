import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { complete } from '@earendil-works/pi-ai/compat'
import { readPiSettings, type PiSettings } from '../config/pi.ts'
import type { WorklingDatabase } from '../db/index.ts'
import { issues, repos, triageRecords } from '../db/schema.ts'
import { docBranch } from '../issue/branch.ts'
import { ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'
import { judgeTrust, type FeedbackState } from './feedback.ts'
import { redactSecrets } from './secret-scan.ts'
import { TRIAGE_PROMPT } from './triage-prompt.ts'

// LLM 调用串行执行，每仓库每轮最坏耗时 5 × 60 秒，会推迟主循环的其他步骤。

export function checkIssue(body: string) {
  const sections = new Map<string, string>()
  let section = '',
    fence = ''
  const lines: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      if (!fence) fence = marker[1]!
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = ''
      continue
    }
    if (fence) {
      if (section) sections.set(section, (sections.get(section) ?? '') + line.trim())
      continue
    }
    lines.push(line)
    const heading = /^\s{0,3}##\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      section = heading[1]!
      if (!sections.has(section)) sections.set(section, '')
    } else if (section) sections.set(section, (sections.get(section) ?? '') + line.trim())
  }
  const missingSections = ['目标', '验收'].filter((name) => !sections.get(name)?.trim())
  const invalidDirectives: string[] = []
  const branch = docBranch(body)
  if (branch && 'error' in branch) invalidDirectives.push(branch.error)
  for (const line of lines) {
    const directive = /^\s*(强度|模型)：(.*)$/.exec(line)
    if (
      directive &&
      (directive[1] === '模型'
        ? !directive[2]!.trim()
        : !['low', 'medium', 'high', 'xhigh'].includes(directive[2]!.trim()))
    )
      invalidDirectives.push(`${directive[1]}：格式无效`)
  }
  return { missingSections, invalidDirectives }
}
const issueSchema = Type.Array(
  Type.Object({
    number: Type.Integer(),
    title: Type.String(),
    body: Type.Union([Type.String(), Type.Null()]),
    user: Type.Object({ id: Type.Integer(), login: Type.String(), type: Type.String() }),
    updated_at: Type.String(),
    pull_request: Type.Optional(Type.Unknown()),
  }),
)
const resultSchema = Type.Object({
  decision: Type.Union([
    Type.Literal('accept'),
    Type.Literal('needs_info'),
    Type.Literal('ignore'),
  ]),
  missing: Type.Array(Type.String()),
  note: Type.String(),
})
export function escapeIssueDelimiters(text: string) {
  return text.replace(/<\/?issue-body>/gi, (tag) => tag.replace('<', '&lt;').replace('>', '&gt;'))
}
type Input = {
  title: string
  body: string
  checks: ReturnType<typeof checkIssue>
  pi: PiSettings
  signal: AbortSignal
}
export async function classifyIssue(input: Input): Promise<unknown> {
  const id = input.pi.piModel ?? input.pi.model
  const result = await complete(
    {
      id,
      name: id,
      api: input.pi.llmApi,
      provider: 'openai',
      baseUrl: input.pi.llmBaseUrl!,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    },
    {
      systemPrompt: TRIAGE_PROMPT,
      messages: [
        {
          role: 'user',
          content: `检查结果：${JSON.stringify(input.checks)}\n<issue-body>\n标题：${escapeIssueDelimiters(input.title)}\n正文：${escapeIssueDelimiters(input.body.slice(0, 20000))}\n</issue-body>`,
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: input.pi.llmApiKey!,
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(60000)]),
    },
  )
  if (result.stopReason === 'error' || result.stopReason === 'aborted')
    throw new Error(result.errorMessage ?? 'LLM 调用失败')
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}
export function parseTriageResult(input: unknown) {
  if (typeof input === 'string') {
    let parsed: unknown
    for (let start = input.indexOf('{'); start >= 0; start = input.indexOf('{', start + 1)) {
      for (let end = start + 1; end <= input.length; end++) {
        if (input[end - 1] !== '}') continue
        try {
          const candidate: unknown = JSON.parse(input.slice(start, end))
          if (Value.Check(resultSchema, candidate)) {
            parsed = candidate
            break
          }
        } catch {
          /* 查找完整对象 */
        }
      }
      if (parsed) break
    }
    input = parsed
  }
  if (!Value.Check(resultSchema, input)) throw new Error('LLM 输出格式无效')
  return {
    decision: input.decision,
    missing: input.missing.slice(0, 10).map((s) => s.slice(0, 200)),
    note: input.note.slice(0, 2000),
  }
}
export type TriageState = {
  permissions: FeedbackState['permissions']
  missingConfigLogged?: boolean
}
export async function triageShadow({
  db,
  command,
  log,
  signal,
  state,
  classify = classifyIssue,
  now = new Date(),
}: {
  db: WorklingDatabase
  command: Command
  log: (message: string) => void
  signal: AbortSignal
  state: TriageState
  classify?: (input: Input) => Promise<unknown>
  now?: Date
}) {
  const repositories = db
    .select()
    .from(repos)
    .where(
      and(eq(repos.enabled, true), eq(repos.platform, 'github'), eq(repos.triageLevel, 'shadow')),
    )
    .all()
  if (!repositories.length) return
  const pi = readPiSettings(db)
  if (!pi.llmBaseUrl || !pi.llmApiKey) {
    if (!state.missingConfigLogged) {
      log('分诊需要在设置页配置 LLM 接入地址与 Key，暂不分诊')
      state.missingConfigLogged = true
    }
    return
  }
  for (const repo of repositories) {
    if (signal.aborted) break
    try {
      const env = ghEnv(repo.token, repo.host)
      const data: unknown = JSON.parse(
        await command(
          [
            'gh',
            'api',
            `repos/${repo.path}/issues?state=open&sort=updated&direction=desc&per_page=100`,
          ],
          { env, signal },
        ),
      )
      if (
        !Value.Check(issueSchema, data) ||
        data.some((item) => !Number.isFinite(Date.parse(item.updated_at)))
      )
        throw new Error('Issue 格式无效')
      let calls = 0
      for (const item of data) {
        if (signal.aborted || calls >= 5) break
        const updated = new Date(item.updated_at)
        if ('pull_request' in item || now.getTime() - updated.getTime() < 600000) continue
        const body = item.body ?? ''
        const hash = createHash('sha256').update(`${item.title}\n${body}`).digest('hex')
        const old = db
          .select()
          .from(triageRecords)
          .where(
            and(
              eq(triageRecords.repoId, repo.id),
              eq(triageRecords.number, item.number),
              eq(triageRecords.contentHash, hash),
            ),
          )
          .get()
        if (old && (old.decision || now.getTime() - old.triagedAt.getTime() < 3600000)) continue
        const trust = await judgeTrust({
          db,
          repo,
          user: item.user,
          body,
          command,
          env,
          signal,
          permissions: state.permissions,
        })
        if (trust !== 'allowlist' && trust !== 'write') continue
        const checks = checkIssue(body)
        const missing = [
          ...checks.missingSections.map((s) => `缺少「${s}」`),
          ...checks.invalidDirectives,
        ]
        let decision: 'accept' | 'needs_info' | 'ignore' | null = null,
          llmDecision: 'accept' | 'needs_info' | 'ignore' | null = null,
          note: string | null = null,
          error: string | null = null
        calls++
        try {
          const result = parseTriageResult(
            await classify({ title: item.title, body: body.slice(0, 20000), checks, pi, signal }),
          )
          llmDecision = result.decision
          decision = result.decision === 'accept' && missing.length ? 'needs_info' : result.decision
          missing.push(...result.missing)
          note = result.note
        } catch (e) {
          error = redactSecrets(errorMessage(e), [pi.llmApiKey, repo.token])
        }
        if (signal.aborted) break
        const values = {
          repoId: repo.id,
          number: item.number,
          title: item.title,
          authorId: String(item.user.id),
          authorLogin: item.user.login,
          trust,
          contentHash: hash,
          issueUpdatedAt: old?.issueUpdatedAt ?? updated,
          checks: JSON.stringify(checks),
          decision,
          llmDecision,
          missing: JSON.stringify([...new Set(missing)]),
          note,
          model: pi.piModel ?? pi.model,
          error,
          alreadyReady:
            (decision ? undefined : old?.alreadyReady) ??
            !!db
              .select()
              .from(issues)
              .where(and(eq(issues.repoId, repo.id), eq(issues.number, item.number)))
              .get(),
          attempts: (old?.attempts ?? 0) + 1,
          triagedAt: now,
        }
        db.insert(triageRecords)
          .values(values)
          .onConflictDoUpdate({
            target: [triageRecords.repoId, triageRecords.number, triageRecords.contentHash],
            set: values,
          })
          .run()
      }
    } catch (error) {
      if (!signal.aborted)
        log(
          `${repo.ref} 分诊失败：${redactSecrets(errorMessage(error), [repo.token, pi.llmApiKey])}`,
        )
    }
  }
}
