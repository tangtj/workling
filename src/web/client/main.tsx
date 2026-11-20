import '../assets/style.css'
import { SettingsPage } from './pages/settings.tsx'
import { settingsOptions } from './settings.ts'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layout } from './layout.tsx'
import { NotFound } from './not-found.tsx'
import { issueListOptions } from './issue-list.ts'
import { IssuesPage } from './pages/issues.tsx'
import { overviewOptions } from './overview.ts'
import { OverviewPage } from './pages/overview.tsx'
import { reposOptions } from './repos.ts'
import { ReposPage } from './pages/repos.tsx'
import { RepoPage } from './pages/repo.tsx'
import { issueDetailOptions, parseDetailId, runDetailOptions } from './issue-detail.ts'
import { IssuePage } from './pages/issue.tsx'
import { RunLogPage } from './pages/run-log.tsx'

const queryClient = new QueryClient()
const router = createBrowserRouter([
  {
    Component: Layout,
    children: [
      {
        path: '/issues/:id',
        Component: IssuePage,
        async loader({ params }) {
          // Finish loading before React Router restores scroll positions against the new content.
          try {
            await queryClient.fetchQuery(issueDetailOptions(parseDetailId(params.id)))
          } catch {
            /* IssuePage renders the retry action. */
          }
          return null
        },
      },
      {
        path: '/runs/:id/log',
        Component: RunLogPage,
        async loader({ params }) {
          try {
            await queryClient.fetchQuery(runDetailOptions(parseDetailId(params.id)))
          } catch {
            /* RunLogPage renders the retry action. */
          }
          return null
        },
      },
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
      {
        path: '/settings',
        Component: SettingsPage,
        async loader() {
          try {
            await queryClient.fetchQuery(settingsOptions)
          } catch {}
          return null
        },
      },
      {
        path: '/repos',
        Component: ReposPage,
        async loader() {
          await Promise.allSettled([
            queryClient.fetchQuery(reposOptions),
            queryClient.fetchQuery(issueListOptions),
          ])
          return null
        },
      },
      {
        path: '/',
        Component: OverviewPage,
        async loader() {
          try {
            await queryClient.fetchQuery(overviewOptions)
          } catch {}
          return null
        },
      },
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
