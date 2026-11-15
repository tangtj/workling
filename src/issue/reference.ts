export type Platform = 'github' | 'gitlab'

export interface IssueRef {
  platform: Platform
  host: string
  project: string
  iid: number
}

const invalidReference = (text: string): never => {
  throw new Error(`无法识别的 Issue 引用：${text}`)
}

const validProject = (project: string, platform: Platform): boolean => {
  const segments = project.split('/')
  return (
    segments.length >= 2 &&
    (platform !== 'github' || segments.length === 2) &&
    segments.every((segment) => /^[\w.-]+$/.test(segment))
  )
}

const makeRef = (
  platform: Platform,
  host: string,
  project: string,
  iidText: string,
  input: string,
) => {
  if (!validProject(project, platform) || !/^[1-9]\d*$/.test(iidText))
    return invalidReference(input)
  return { platform, host, project, iid: Number(iidText) }
}

export function parseIssueRef(text: string, gitlabHost = 'gitlab.com'): IssueRef {
  const input = text.trim()
  const short = /^(github|gitlab):(.+)#([1-9]\d*)$/.exec(input)
  if (short) {
    const platform = short[1] as Platform
    return makeRef(
      platform,
      platform === 'github' ? 'github.com' : gitlabHost,
      short[2]!,
      short[3]!,
      text,
    )
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return invalidReference(text)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return invalidReference(text)

  if (url.host.toLowerCase() === 'github.com') {
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([^/]+)\/?$/.exec(url.pathname)
    if (!match) return invalidReference(text)
    return makeRef('github', 'github.com', `${match[1]}/${match[2]}`, match[3]!, text)
  }

  const match = /^\/(.+)\/-\/issues\/([^/]+)\/?$/.exec(url.pathname)
  if (!match) return invalidReference(text)
  return makeRef('gitlab', url.host, match[1]!, match[2]!, text)
}

export interface RepoRef {
  platform: Platform
  host: string
  path: string
}

export function parseRepoRef(text: string, gitlabHost = 'gitlab.com'): RepoRef {
  const invalid = (): never => {
    throw new Error(`无法识别的仓库引用：${text}`)
  }
  const input = text.trim()
  const short = /^(github|gitlab):(.+)$/.exec(input)
  if (short) {
    const platform = short[1] as Platform
    const path = short[2]!
    if (!validProject(path, platform)) return invalid()
    return { platform, host: platform === 'github' ? 'github.com' : gitlabHost, path }
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return invalid()
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    return invalid()
  const host = url.host.toLowerCase()
  const platform =
    host === 'github.com' ? 'github' : host === gitlabHost.toLowerCase() ? 'gitlab' : null
  if (!platform) return invalid()
  const path = url.pathname
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
  if (!validProject(path, platform)) return invalid()
  return { platform, host, path }
}

export function formatRepoRef(ref: RepoRef): string {
  return `${ref.platform}:${ref.path}`
}
