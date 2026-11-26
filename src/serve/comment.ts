import { and, count, eq, lte, ne } from 'drizzle-orm'
import { maxCommentLength } from '../contract/out.ts'
import type { WorklingDatabase } from '../db/index.ts'
import { runs } from '../db/schema.ts'

export const AI_NOTICE = '— Sent via [Workling](https://github.com/tangtj/workling)'

/** 可见标识说明内容由 AI 生成，隐藏标记用于识别自身评论；处理正文后追加以免被移除。 */
export function markComment(body: string): string {
  return `${body}\n\n\n${AI_NOTICE}\n\n<!-- workling -->`
}

export function neutralizeMentions(text: string): string {
  // 现有反引号可能和新插入的反引号配对，使提及落到代码之外。
  const useHtml = text.includes('`') || /\\@|@[A-Za-z0-9_/-]*@/.test(text)
  return text.replace(/\\?@([A-Za-z0-9-]+(?:\/[A-Za-z0-9_-]+)?)/g, (_, name: string) =>
    useHtml ? `<code>&#64;${name}</code>` : `\`@${name}\``,
  )
}

export const runKindLabel = { implement: '实现', rework: '返工', plan: '拆解', review: '评审' }

export function runComment({
  title,
  facts,
  body,
  tail,
  next,
}: {
  title: string
  facts: string[]
  body?: string
  tail?: string
  next?: string
}): string {
  const header = [`### ${title}`, facts.join(' · ')].filter(Boolean).join('\n\n')
  const footer = [tail, next && `**下一步**：${next}`].filter(Boolean).join('\n\n')
  const overhead = header.length + 2 + (footer ? footer.length + 2 : 0)
  if (body && overhead + body.length > maxCommentLength) {
    const marker = '\n\n（已截断）'
    const limit = maxCommentLength - overhead
    // 空间不足时优先保留固定内容。
    body =
      limit >= marker.length
        ? body.slice(0, limit - marker.length).replace(/[\uD800-\uDBFF]$/, '') + marker
        : limit >= '（已截断）'.length
          ? '（已截断）'
          : undefined
  }
  return [header, body, footer].filter(Boolean).join('\n\n')
}

export function normalizeBody(text: string): string {
  const body = text.trim().replace(/^(?:交付结果|结果)[：:](?:部分完成|未完成|完成)[。.]?\s*/, '')
  const lines: string[] = []
  let fence: string | undefined
  let blank = false
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    const marker = opening?.[1]
    if (fence) {
      if (marker?.startsWith(fence) && !opening?.[2]?.trim()) fence = undefined
      lines.push(raw)
    } else if (marker && (marker[0] === '~' || !opening?.[2]?.includes('`'))) {
      fence = marker
      lines.push(raw)
    } else if (line === '') {
      if (!blank) lines.push(raw)
    } else {
      const heading = /^ {0,3}#{1,6}[ \t]+(.+)$/.exec(line)?.[1]
      const title = heading?.trimEnd().replace(/(?:^|[ \t]+)#+$/, '')
      const formatted =
        title && (!title.startsWith('**') || !title.endsWith('**')) ? `**${title}**` : title
      lines.push(formatted ? formatted + (raw.endsWith('\r') ? '\r' : '') : raw)
    }
    blank = line === '' && !fence
  }
  return lines.join('\n')
}

export function runRound(db: WorklingDatabase, issueId: number, runId: number): number {
  return db
    .select({ round: count() })
    .from(runs)
    .where(and(eq(runs.issueId, issueId), ne(runs.kind, 'review'), lte(runs.id, runId)))
    .get()!.round
}

export function formatDuration(startedAt: Date, endedAt: Date): string {
  const minutes = Math.max(1, Math.ceil((endedAt.getTime() - startedAt.getTime()) / 60_000))
  if (minutes < 60) return `用时 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return `用时 ${hours} 小时${remainder ? ` ${remainder} 分钟` : ''}`
}

export function formatPrLink(url: string): string {
  const pr = /\/pull\/(\d+)$/.exec(url)
  return pr ? `[PR #${pr[1]}](${url})` : url
}
