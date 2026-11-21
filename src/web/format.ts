const pad = (n: number) => String(n).padStart(2, '0')

export function formatTime(date: Date, now: number): string {
  const today = new Date(now)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.toDateString() === today.toDateString()
    ? time
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

export function relativeTime(date: Date, now: number): string {
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`
  const days = Math.floor(minutes / (24 * 60))
  return days === 1 ? '昨天' : `${days} 天前`
}

/** 表格里只显示仓库名与编号（`github:tangtj/workling` + 67 → `workling#67`），完整 ref 放 title。 */
export function shortRef(repoRef: string, number: number): string {
  const name =
    repoRef
      .slice(repoRef.indexOf(':') + 1)
      .split('/')
      .pop() || repoRef
  return `${name}#${number}`
}

export function prLabel(url: string): string {
  const match = url.match(/\/(\d+)\/?(?:[?#].*)?$/)
  return match ? `#${match[1]}` : url
}

export function secondsAgo(date: Date, now: number): string {
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000))
  return seconds < 60 ? `${seconds} 秒前` : relativeTime(date, now)
}
