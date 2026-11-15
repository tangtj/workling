import '../assets/style.css'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layout } from './layout.tsx'
import { LegacyPage, NotFound } from './legacy-page.tsx'
import { fragmentOptions } from './legacy.ts'

const queryClient = new QueryClient()
const router = createBrowserRouter([
  {
    Component: Layout,
    children: [
      ...['/', '/issues', '/issues/:id', '/repos', '/repos/:id', '/settings', '/runs/:id/log'].map(
        (path) => ({
          path,
          Component: LegacyPage,
          async loader({ request }: { request: Request }) {
            const url = new URL(request.url)
            // Finish loading before React Router restores scroll positions against the new content.
            try {
              await queryClient.fetchQuery(fragmentOptions(url.pathname + url.search))
            } catch {
              /* LegacyPage renders the retry action. */
            }
            return null
          },
        }),
      ),
      { path: '*', Component: NotFound },
    ],
  },
])

const root = document.getElementById('root')
if (!root) throw new Error('缺少应用挂载点')
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
)
