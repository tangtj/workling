import { markComment, neutralizeMentions } from './comment.ts'
import { redactSecrets } from './secret-scan.ts'

export function suggestComment(missing: string[], secrets: string[] = []): string {
  const items = missing
    .map((item) =>
      redactSecrets(
        neutralizeMentions(
          item
            .replace(/[\r\n]+/g, ' ')
            .trim()
            .slice(0, 200)
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/https?:\/\/\S+/gi, '（链接已省略）'),
        ),
        secrets,
      )
        .replaceAll('@', '&#64;')
        .trim(),
    )
    .filter(Boolean)
  if (!items.length) items.push('目标、范围或验收描述不够清楚')
  return markComment(
    `workling：这个 Issue 暂时还不能直接交给 workling 执行，还缺少以下信息：\n\n${items.map((item) => `- ${item}`).join('\n')}\n\n补充正文后不需要其他操作，workling 会在正文修改 10 分钟后重新判断；信息齐全后摘掉 \`workling:needs-info\`。如果认为已经可以执行，直接打 \`workling:ready\`。\n\n（自动分诊 · 建议级）`,
  )
}
