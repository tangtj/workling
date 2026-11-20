import { useEffect } from 'react'
import { Link } from 'react-router'
import { usePageLayout } from './layout.tsx'

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
