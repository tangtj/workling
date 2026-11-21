/** 标记放在处理正文之后，确保截断和脱敏不会移除它。 */
export function markComment(body: string): string {
  return `${body}\n\n<!-- workling -->`
}

export function neutralizeMentions(text: string): string {
  // 现有反引号可能和新插入的反引号配对，使提及落到代码之外。
  const useHtml = text.includes('`') || /\\@|@[A-Za-z0-9_/-]*@/.test(text)
  return text.replace(/\\?@([A-Za-z0-9-]+(?:\/[A-Za-z0-9_-]+)?)/g, (_, name: string) =>
    useHtml ? `<code>&#64;${name}</code>` : `\`@${name}\``,
  )
}
