import { useEffect, useLayoutEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { fragmentOptions, internalLink } from './legacy.ts'
import { usePageLayout } from './layout.tsx'

export function LegacyPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { setActive } = usePageLayout()
  const root = useRef<HTMLDivElement>(null)
  const page = useQuery(fragmentOptions(location.pathname + location.search))
  const data = page.data

  useLayoutEffect(() => {
    if (!data) return
    document.title = `${data.title} · Workling`
    setActive(data.active)
    if (location.hash) {
      try {
        document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView()
      } catch {}
    }
  }, [data, location.key, setActive])

  useLayoutEffect(() => {
    const container = root.current
    if (!data || !container) return
    const click = (event: MouseEvent) => {
      const href = internalLink(event, container)
      if (href === undefined) return
      event.preventDefault()
      void navigate(href)
    }
    container.addEventListener('click', click)
    return () => container.removeEventListener('click', click)
  }, [data, page.dataUpdatedAt, location.key, navigate])

  useEffect(() => {
    if (!data?.refresh) return
    const timer = setInterval(() => {
      if (
        !document.hidden &&
        !document.querySelector('dialog[open], [role="dialog"]:not([hidden])') &&
        document.body.dataset.refreshPaused !== 'true'
      )
        void page.refetch()
    }, data.refresh * 1000)
    return () => clearInterval(timer)
  }, [data?.refresh, page.refetch])

  if (!data && page.isPending) return <p className="muted">加载中…</p>
  return (
    <>
      {page.isError && (
        <p className="error-box" role="alert">
          加载页面失败{' '}
          <button className="button" type="button" onClick={() => void page.refetch()}>
            重试
          </button>
        </p>
      )}
      {data && (
        <div
          className="legacy-content"
          key={`${location.key}:${page.dataUpdatedAt}`}
          ref={root}
          dangerouslySetInnerHTML={{ __html: data.html }}
        />
      )}
    </>
  )
}

export function NotFound() {
  const { setActive } = usePageLayout()
  useEffect(() => {
    setActive('')
    document.title = '页面不存在 · Workling'
  }, [setActive])
  return (
    <section className="card">
      <h1>页面不存在</h1>
      <p>无法找到请求的页面。</p>
      <Link to="/">返回工作台</Link>
    </section>
  )
}
