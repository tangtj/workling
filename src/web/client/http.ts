export type Active = '' | 'overview' | 'issues' | 'repos' | 'settings'

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
