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
