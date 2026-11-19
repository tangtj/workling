export function init(root) {
  const controller = new AbortController()
  let disposed = false
  const timers = new Set()
  const on = (node, type, handler) =>
    node?.addEventListener(type, handler, { signal: controller.signal })
  const later = (callback, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!disposed) callback()
    }, ms)
    timers.add(timer)
  }
  root.querySelectorAll('[data-copy]').forEach((button) =>
    on(button, 'click', async () => {
      await navigator.clipboard.writeText(button.dataset.copy)
      if (disposed) return
      const label = button.textContent
      button.textContent = '已复制'
      later(() => {
        button.textContent = label
      }, 2000)
    }),
  )
  return () => {
    disposed = true
    controller.abort()
    for (const timer of timers) clearTimeout(timer)
    root.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close())
  }
}
