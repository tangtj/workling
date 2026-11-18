import '../assets/style.css'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layout } from './layout.tsx'
import { LegacyPage, NotFound } from './legacy-page.tsx'
import { fragmentOptions } from './legacy.ts'
import { issueListOptions } from './issue-list.ts'
import { IssuesPage } from './pages/issues.tsx'
import { RepoPage } from './pages/repo.tsx'

const queryClient = new QueryClient()
const router = createBrowserRouter([
  {
    Component: Layout,
    children: [
      ...['/', '/issues/:id', '/repos', '/settings', '/runs/:id/log'].map((path) => ({
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
      })),
      ...[
        { path: '/issues', Component: IssuesPage },
        { path: '/repos/:id', Component: RepoPage },
      ].map((route) => ({
        ...route,
        async loader() {
          try {
            await queryClient.fetchQuery(issueListOptions)
          } catch {}
          return null
        },
      })),
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
