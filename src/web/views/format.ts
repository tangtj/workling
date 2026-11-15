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
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`
}

export function prLabel(url: string): string {
  const match = url.match(/\/(\d+)\/?(?:[?#].*)?$/)
  return match ? `#${match[1]}` : url
}

export function secondsAgo(date: Date, now: number): string {
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000))
  return seconds < 60 ? `${seconds} 秒前` : relativeTime(date, now)
}
