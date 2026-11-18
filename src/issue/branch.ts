export function shortName(title: string): string {
  return (
    (title.match(/[A-Za-z0-9]+/g) ?? []).join('-').toLowerCase().slice(0, 30).replace(/-$/, '') ||
    'task'
  )
}

export function taskBranch(number: number, title: string): string {
  return `workling/${number}-${shortName(title)}`
}

function validDocBranch(name: string): boolean {
  // 字符白名单已排除 Git 禁用的大部分字符与 @{-n}；这里补齐 check-ref-format --branch 的其余规则。
  return (
    /^[A-Za-z0-9/._-]+$/.test(name) &&
    name !== 'HEAD' &&
    !name.startsWith('-') &&
    !name.endsWith('.') &&
    !name.includes('..') &&
    name.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
  )
}

export function docBranch(body: string): { name: string } | { error: string } | undefined {
  let fence: string | undefined
  let inComment = false
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = undefined
      continue
    }
    if (!inComment) {
      if (marker && (marker[1]![0] === '~' || !marker[2]!.includes('`'))) {
        fence = marker[1]
        continue
      }
      const trimmed = line.trim()
      if (trimmed.startsWith('分支：')) {
        const name = trimmed.slice('分支：'.length).trim()
        return validDocBranch(name)
          ? { name }
          : { error: 'Issue 正文的「分支：」行未填写有效的文档分支名' }
      }
    }
    let cursor = 0
    while (cursor < line.length) {
      const delimiter = inComment ? '-->' : '<!--'
      const next = line.indexOf(delimiter, cursor)
      if (next === -1) break
      inComment = !inComment
      cursor = next + delimiter.length
    }
  }
}
