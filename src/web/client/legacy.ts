export type Active = '' | 'overview' | 'issues' | 'repos' | 'settings'
export type LegacyContext = { navigate: (url: string) => void; refresh: () => void }
type LegacyModule = { init: (root: HTMLElement, ctx: LegacyContext) => () => void }
type VersionModule = { init: () => () => void }

// URL imports stay external so the server and browser use one copy of each legacy script.
async function loadModule<T>(url: string): Promise<T> {
  try {
    return await import(url)
  } catch (error) {
    // Module imports cannot inspect an authentication redirect's response themselves.
    await readResponse('/api/shell')
    throw error
  }
}
export const loadApp = () => loadModule<LegacyModule>('/app.js')
export const loadRunLog = () => loadModule<LegacyModule>('/run-log.js')
export const loadVersion = () => loadModule<VersionModule>('/version.js')

export async function readResponse(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  if (
    response.status === 401 ||
    (response.redirected && new URL(response.url).pathname === '/login')
  ) {
    location.assign('/login')
    throw new Error('未登录')
  }
  return response
}

export type Fragment = { html: string; title: string; active: Active; refresh: number }
export function fragmentOptions(url: string) {
  return {
    queryKey: ['fragment', url],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Fragment> => {
      const response = await readResponse(url, { signal, headers: { 'X-Workling-Fragment': '1' } })
      if (!response.headers.get('Content-Type')?.includes('text/html'))
        throw new Error('加载页面失败')
      const active = response.headers.get('X-Workling-Active')
      const refresh = Number(response.headers.get('X-Workling-Refresh'))
      return {
        html: await response.text(),
        title: decodeURIComponent(response.headers.get('X-Workling-Title') ?? 'Workling'),
        active:
          active === 'overview' ||
          active === 'issues' ||
          active === 'repos' ||
          active === 'settings'
            ? active
            : '',
        refresh: Number.isFinite(refresh) && refresh > 0 ? refresh : 0,
      }
    },
    retry: false as const,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false as const,
    structuralSharing: false as const,
  }
}

export function internalLink(event: MouseEvent, root: HTMLElement): string | undefined {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return
  const target = event.target instanceof Element ? event.target : null
  const link = target?.closest('a')
  if (
    !(link instanceof HTMLAnchorElement) ||
    !root.contains(link) ||
    link.hasAttribute('download') ||
    (link.target && link.target !== '_self')
  )
    return
  const href = link.getAttribute('href')
  // Hash-only links also need router state updates (including the add-repository drawer).
  if (!href || (!href.startsWith('/') && !href.startsWith('#'))) return
  const url = new URL(href, location.href)
  if (
    url.origin !== location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/login'
  )
    return
  return url.pathname + url.search + url.hash
}
