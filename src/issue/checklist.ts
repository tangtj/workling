import type { ChecklistItem } from '../contract/out.ts'

const listMarker = /^( *)(?:[-+*]|\d{1,9}[.)])([ \t]+)/

function checklistLines(body: string) {
  const matches = new Map<string, { offset: number; checked: boolean }[]>()
  const indents: number[] = []
  let quoted = 0
  let comment = false
  let fence: { marker: string; length: number; indent: number } | undefined
  for (const match of body.matchAll(/[^\r\n]+/g)) {
    const line = match[0]
    if (!line.trim()) continue
    // 根级围栏中的 > 是代码内容，不是引用容器。
    const quotes = fence && quoted === 0 ? '' : (/^(?: {0,3}>[ \t]?)+/.exec(line)?.[0] ?? '')
    const depth = quotes.split('>').length - 1
    if (depth !== quoted) {
      indents.length = 0
      if (quoted > 0) fence = undefined
      quoted = depth
    }
    const text = line.slice(quotes.length)
    const indent = /^ */.exec(text)![0].length
    if (fence && indent < fence.indent) fence = undefined
    if (fence) {
      const closing = /^( *)([~`]+)[ \t]*$/.exec(text)
      if (
        closing &&
        closing[1]!.length <= fence.indent + 3 &&
        closing[2]!.length >= fence.length &&
        closing[2]!.replaceAll(fence.marker, '') === ''
      )
        fence = undefined
      continue
    }

    while (indents.length && indent < indents.at(-1)!) indents.pop()
    const parentIndent = indents.at(-1) ?? 0
    const relative = text.slice(parentIndent)
    const list = listMarker.exec(relative)
    const content = list ? relative.slice(list[0].length) : relative
    const isComment = comment
    const isIndentedCode = indent - parentIndent >= 4 || relative.startsWith('\t')
    if (!comment && !isIndentedCode) {
      const opening = /^ {0,3}(~{3,}|`{3,})(.*)$/.exec(content)
      if (list) indents.push(parentIndent + list[0].length)
      if (opening && (opening[1]![0] === '~' || !opening[2]!.includes('`'))) {
        fence = { marker: opening[1]![0]!, length: opening[1]!.length, indent: indents.at(-1) ?? 0 }
        continue
      }
    }
    if (comment || !isIndentedCode) {
      for (const token of text.matchAll(/<!--|-->/g)) {
        if (comment) {
          if (token[0] === '-->') comment = false
        } else if (token[0] === '<!--') comment = true
      }
    }
    if (isComment || isIndentedCode) continue

    const task = /^\[([ xX])\](?=[ \t]|$)/.exec(content)
    if (!list || !task) continue
    const key = line.trimEnd()
    const occurrence = {
      offset: match.index + line.length - content.length + 1,
      checked: task[1] !== ' ',
    }
    const same = matches.get(key)
    if (same) same.push(occurrence)
    else matches.set(key, [occurrence])
  }
  return matches
}

export function planChecklist(body: string, items: readonly ChecklistItem[]) {
  const lines = checklistLines(body)
  const changes: ChecklistItem[] = []
  const skipped: { item: ChecklistItem; reason: 'missing' | 'ambiguous' | 'unchanged' }[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const key = item.line.trimEnd()
    const matches = lines.get(key)
    if (!matches) skipped.push({ item, reason: 'missing' })
    else if (matches.length !== 1) skipped.push({ item, reason: 'ambiguous' })
    else if (matches[0]!.checked === item.checked) skipped.push({ item, reason: 'unchanged' })
    else if (!seen.has(key)) {
      changes.push(item)
      seen.add(key)
    }
  }
  return { changes, skipped }
}

export function applyChecklist(body: string, changes: readonly ChecklistItem[]): string {
  const lines = checklistLines(body)
  const edits = new Map<number, string>()
  for (const { line, checked } of changes) {
    const matches = lines.get(line.trimEnd())
    if (matches?.length !== 1 || matches[0]!.checked === checked) continue
    edits.set(matches[0]!.offset, checked ? 'x' : ' ')
  }
  let end = 0
  let updated = ''
  for (const [offset, marker] of [...edits].sort(([a], [b]) => a - b)) {
    updated += body.slice(end, offset) + marker
    end = offset + 1
  }
  return updated + body.slice(end)
}
