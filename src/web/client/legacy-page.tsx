import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fragmentOptions, internalLink, loadApp, loadRunLog } from './legacy.ts'
import { shellKey, usePageLayout } from './layout.tsx'

export function LegacyPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { setActive } = usePageLayout()
  const root = useRef<HTMLDivElement>(null)
  const [scriptError, setScriptError] = useState(false)
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
    let disposed = false
    const cleanup: Array<() => void> = []
    const ctx = {
      navigate(url: string) {
        if (disposed) return
        void queryClient.invalidateQueries({ queryKey: shellKey })
        void navigate(url)
      },
      refresh() {
        if (disposed) return
        void queryClient.invalidateQueries({ queryKey: shellKey })
        void page.refetch()
      },
    }
    setScriptError(false)
    void (async () => {
      const app = await loadApp()
      if (disposed) return
      cleanup.push(app.init(container, ctx))
      if (container.querySelector('.run-timeline')) {
        const log = await loadRunLog()
        if (!disposed) cleanup.push(log.init(container, ctx))
      }
    })().catch(() => {
      if (!disposed) setScriptError(true)
    })
    const click = (event: MouseEvent) => {
      const href = internalLink(event, container)
      if (href === undefined) return
      event.preventDefault()
      void navigate(href)
    }
    container.addEventListener('click', click)
    return () => {
      disposed = true
      container.removeEventListener('click', click)
      cleanup.reverse().forEach((destroy) => destroy())
    }
  }, [data, page.dataUpdatedAt, location.key, navigate, queryClient])

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
      {(page.isError || scriptError) && (
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
