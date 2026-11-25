import type { Command, Environment } from '../runtime/types.ts'

export function ghEnv(token: string, host: string): Environment {
  return { ...process.env, GH_TOKEN: token, GH_HOST: host, GH_PROMPT_DISABLED: '1' }
}

const branches = new Map<string, { name: string; expires: number }>()

export function clearDefaultBranchCache() {
  branches.clear()
}

export async function defaultBranch({
  repo,
  command,
  signal,
}: {
  repo: { host: string; path: string; token: string }
  command: Command
  signal?: AbortSignal
}): Promise<string> {
  const key = `${repo.host}/${repo.path}`
  const cached = branches.get(key)
  if (cached && cached.expires > Date.now()) return cached.name
  const name = await command(['gh', 'api', `repos/${repo.path}`, '--jq', '.default_branch'], {
    env: ghEnv(repo.token, repo.host),
    signal,
  })
  if (!name || name.startsWith('-') || /\s/.test(name)) throw new Error('默认分支无效')
  branches.set(key, { name, expires: Date.now() + 10 * 60 * 1000 })
  return name
}
