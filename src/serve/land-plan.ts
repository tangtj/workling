import { and, eq } from 'drizzle-orm'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import {
  maxCommentLength,
  missingOutput,
  readOutputFile,
  readPlan,
  type Plan,
} from '../contract/out.ts'
import type { WorklingDatabase } from '../db/index.ts'
import { planChildren } from '../db/schema.ts'
import { docBranch, findDirective } from '../issue/branch.ts'
import { errorMessage } from '../runtime/errors.ts'
import { findSecrets } from './secret-scan.ts'
import { checkIssue } from './triage.ts'

const createdIssueSchema = Type.Object({
  number: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
})

export async function preparePlan(
  out: string,
  parent: number,
  runId: number,
  branch: string | null,
  secrets: string[],
): Promise<Plan> {
  const plan = await readPlan(out)
  const explanation = await readOutputFile(out, 'issue-comment.md', maxCommentLength * 3).catch(
    (error: unknown) => {
      if (missingOutput(error)) return undefined
      throw error
    },
  )
  // 把正文视为新增行，沿用提交补丁的密钥规则。
  const content = [
    plan.summary,
    ...plan.children.flatMap(({ title, body }) => [title, body]),
    explanation?.toString('utf8') ?? '',
  ].join('\n')
  const hits = findSecrets(`@@ \n${content.replace(/^/gm, '+')}`, secrets)
  if (hits.length)
    throw new Error(`拆解产出命中密钥规则：${hits.map(({ rule }) => rule).join('、')}`)

  if (!branch && plan.docs.length) throw new Error('没有文档提交，但 plan.json 列出了文档')
  const children = plan.children.map(({ title, body }, index) => {
    const { missingSections, invalidDirectives } = checkIssue(body)
    const errors = [...missingSections.map((name) => `缺少「${name}」`), ...invalidDirectives]
    for (const name of ['分支', '模式'])
      if (findDirective(body, name) !== undefined) errors.push(`不能包含「${name}：」行`)
    if (errors.length)
      throw new Error(`子 Issue ${index + 1}（${title}）格式无效：${errors.join('、')}`)

    const text = body.trimEnd()
    const marker = `<!-- workling:plan parent=#${parent} run=${runId} -->`
    const finalBody = `${text}${branch ? `\n\n分支：${branch}` : ''}\n\n${marker}`
    const directive = docBranch(finalBody)
    // 无文档时也确认末尾没有吞掉来源标记的代码块或注释。
    const visible = branch
      ? directive && 'name' in directive && directive.name === branch
      : directive === undefined && findDirective(`${text}\n\n分支：probe`, '分支') === 'probe'
    if (!visible) throw new Error(`子 Issue ${index + 1}（${title}）的正文末尾有未闭合的代码块`)
    return { title, body: finalBody }
  })
  return { ...plan, children }
}

export async function createPlanChildren({
  db,
  gh,
  path,
  parent,
  runId,
  plan,
}: {
  db: WorklingDatabase
  gh: (args: string[], input?: string) => Promise<string>
  path: string
  parent: number
  runId: number
  plan: Plan
}) {
  const children: { number: number; title: string }[] = []
  const post = (endpoint: string, body: object) =>
    gh(['api', '-X', 'POST', endpoint, '--input', '-'], JSON.stringify(body))
  for (const [index, child] of plan.children.entries()) {
    const position = index + 1
    let record = db
      .select()
      .from(planChildren)
      .where(and(eq(planChildren.runId, runId), eq(planChildren.position, position)))
      .get()
    if (!record) {
      const created: unknown = JSON.parse(await post(`repos/${path}/issues`, child))
      if (!Value.Check(createdIssueSchema, created)) throw new Error('创建子 Issue 的响应格式无效')
      // 创建成功后至写入前若进程退出，重试可能创建重复 Issue。
      record = db
        .insert(planChildren)
        .values({
          runId,
          position,
          number: created.number,
          githubId: created.id,
          title: child.title,
          createdAt: new Date(),
        })
        .returning()
        .get()
    }
    if (!record.linkedAt) {
      try {
        await post(`repos/${path}/issues/${parent}/sub_issues`, { sub_issue_id: record.githubId })
      } catch (error) {
        const message = errorMessage(error)
        if (
          !/HTTP 422\b/.test(message) ||
          !/already (?:a sub[- ]issue of|(?:attached|added|linked) to) this (?:parent )?issue\b/i.test(
            message,
          )
        )
          throw error
      }
      db.update(planChildren)
        .set({ linkedAt: new Date() })
        .where(eq(planChildren.id, record.id))
        .run()
    }
    children.push({ number: record.number, title: record.title })
  }
  return children
}
