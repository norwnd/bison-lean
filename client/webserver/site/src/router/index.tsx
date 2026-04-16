import { Suspense, lazy } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppLayout } from '../layout/AppLayout'
import { AuthGuard, InitGuard, DexConnectionGuard } from './guards'
import { ROUTES } from './routes'

// Lazy-load pages for code splitting.
const LoginPage = lazy(() => import('../pages/LoginPage'))
const RegisterPage = lazy(() => import('../pages/RegisterPage'))
const InitPage = lazy(() => import('../pages/InitPage'))
const MarketsPage = lazy(() => import('../pages/markets'))
const WalletsPage = lazy(() => import('../pages/WalletsPage'))
const OrdersPage = lazy(() => import('../pages/OrdersPage'))
const OrderPage = lazy(() => import('../pages/OrderPage'))
const SettingsPage = lazy(() => import('../pages/SettingsPage'))
const DexSettingsPage = lazy(() => import('../pages/DexSettingsPage'))
const MMPage = lazy(() => import('../pages/MMPage'))
const MMSettingsPage = lazy(() => import('../pages/MMSettingsPage'))
const MMArchivesPage = lazy(() => import('../pages/MMArchivesPage'))
const MMLogsPage = lazy(() => import('../pages/MMLogsPage'))
const ProposalsPage = lazy(() => import('../pages/ProposalsPage'))
const ProposalPage = lazy(() => import('../pages/ProposalPage'))

function PageSuspense ({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className="flex-center p-5">Loading...</div>}>{children}</Suspense>
}

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: ROUTES.LOGIN, element: <PageSuspense><LoginPage /></PageSuspense> },
      { path: ROUTES.REGISTER, element: <PageSuspense><RegisterPage /></PageSuspense> },
      {
        path: ROUTES.INIT,
        element: <InitGuard><PageSuspense><InitPage /></PageSuspense></InitGuard>,
      },
      {
        element: <AuthGuard />,
        children: [
          { index: true, element: <Navigate to={ROUTES.WALLETS} replace /> },
          { path: ROUTES.WALLETS, element: <PageSuspense><WalletsPage /></PageSuspense> },
          { path: ROUTES.SETTINGS, element: <PageSuspense><SettingsPage /></PageSuspense> },
          { path: ROUTES.PROPOSALS, element: <PageSuspense><ProposalsPage /></PageSuspense> },
          { path: ROUTES.PROPOSAL, element: <PageSuspense><ProposalPage /></PageSuspense> },
          {
            element: <DexConnectionGuard />,
            children: [
              { path: ROUTES.MARKETS, element: <PageSuspense><MarketsPage /></PageSuspense> },
              { path: ROUTES.ORDERS, element: <PageSuspense><OrdersPage /></PageSuspense> },
              { path: ROUTES.ORDER, element: <PageSuspense><OrderPage /></PageSuspense> },
              { path: ROUTES.MM, element: <PageSuspense><MMPage /></PageSuspense> },
              { path: ROUTES.MM_SETTINGS, element: <PageSuspense><MMSettingsPage /></PageSuspense> },
              { path: ROUTES.MM_ARCHIVES, element: <PageSuspense><MMArchivesPage /></PageSuspense> },
              { path: ROUTES.MM_LOGS, element: <PageSuspense><MMLogsPage /></PageSuspense> },
              { path: ROUTES.DEX_SETTINGS, element: <PageSuspense><DexSettingsPage /></PageSuspense> },
            ],
          },
        ],
      },
    ],
  },
])
