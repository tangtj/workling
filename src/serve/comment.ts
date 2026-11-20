/** 标记放在处理正文之后，确保截断和脱敏不会移除它。 */
export function markComment(body: string): string {
  return `${body}\n\n<!-- workling -->`
}
