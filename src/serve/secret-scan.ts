const rules = [
  { rule: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]+/g },
  { rule: 'Private key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { rule: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g },
  { rule: 'API key', pattern: /sk-[A-Za-z0-9_-]{20,}/g },
] as const

export function redactSecrets(text: string, extra: string[]): string {
  for (const secret of extra.filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, '***')
  for (const { pattern } of rules) text = text.replace(pattern, '***')
  return text
}

export function findSecrets(patch: string, extra: string[]): { rule: string; file: string }[] {
  const literals = extra.filter(Boolean)
  const hits: { rule: string; file: string }[] = []
  const seen = new Set<string>()
  let file = ''
  let inHunk = false
  const add = (rule: string) => {
    const key = `${rule}\0${file}`
    if (seen.has(key)) return
    seen.add(key)
    hits.push({ rule, file: redactSecrets(file, literals) })
  }
  // 文本 diff 没有二进制文件的新增行，因此不扫描二进制内容。
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = ''
      inHunk = false
    } else if (line.startsWith('@@ ')) inHunk = true
    else if (!inHunk && line.startsWith('+++ ')) {
      // Git 会给含特殊字符的路径加引号；保留其中的转义以便定位。
      const path = line.slice(4).split('\t', 1)[0]!
      file = path.startsWith('"b/') ? path.slice(3, -1) : path.replace(/^b\//, '')
    } else if (line.startsWith('+') && (inHunk || !line.startsWith('+++'))) {
      const added = line.slice(1)
      for (const { rule, pattern } of rules) if (added.search(pattern) !== -1) add(rule)
      if (literals.some((secret) => added.includes(secret))) add('Configured secret')
    }
  }
  return hits
}
