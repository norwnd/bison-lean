import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/useAuthStore'
import { fetchLocal, storeLocal, newUserBannerDismissedLK } from '../services/state'

// NewUserBanner is the "New to Bison Wallet?" banner shown across the top
// of the app for first-time users. Mirrors vanilla `app().showNewUserBanner()`
// (app.ts L334-346) and the `#newUserBanner` markup in `bodybuilder.tmpl`.
//
// Visibility rules (identical to vanilla):
//   - Hidden until `user.seedGenTime` is set (the user has generated a seed).
//   - Hidden if `newUserBannerDismissedLK` localStorage value equals the
//     current `seedGenTime` (user already dismissed it for this seed).
//   - The dismissed state is deliberately keyed to `seedGenTime` so that
//     restoring from the same seed does NOT reset the banner, but a fresh
//     seed generation (or clearing localStorage) re-shows it.
//
// Dismissal writes the current `seedGenTime` to localStorage and hides the
// banner immediately via component state. On the next page reload, the
// component reads the persisted value and stays hidden.
//
// Why a shared component instead of per-page calls: vanilla's
// `showNewUserBanner()` is called from multiple imperative entry points
// (`Application.start()`, `login.ts` loggedIn(), `init.ts` quickConfigDone +
// seedBackedUp) because the banner needs to re-check its conditions whenever
// the auth state changes. In React, a single component subscribed to
// `useAuthStore` re-evaluates on every `seedGenTime` transition automatically,
// so login/init pages don't need to call anything — they just cause `user`
// to update, and this component reacts.
//
// Closes LP-01 (high) + IP-01 (low) with one shared implementation.
export function NewUserBanner () {
  const { t } = useTranslation()
  const seedGenTime = useAuthStore(s => s.seedGenTime)
  // Local state mirrors the localStorage dismissed value but lets us hide
  // immediately on click without a reload. Initialized lazily so the
  // fetchLocal call runs once on mount.
  const [dismissedFor, setDismissedFor] = useState<number>(() => {
    const v = fetchLocal(newUserBannerDismissedLK)
    return typeof v === 'number' ? v : 0
  })

  // Not initialized yet — no seed, nothing to offer.
  if (!seedGenTime) return null
  // Already dismissed for this seed generation.
  if (dismissedFor === seedGenTime) return null

  const dismiss = () => {
    storeLocal(newUserBannerDismissedLK, seedGenTime)
    setDismissedFor(seedGenTime)
  }

  return (
    <div className="p-2 d-flex justify-content-center align-items-center new-user-banner">
      <span className="ico-info fs14 me-1"></span>
      <span className="fs15">{t('NEW_USER_BANNER_MSG')}</span>
      <a
        href="https://github.com/decred/dcrdex/wiki/Home#new-users"
        target="_blank"
        rel="noopener noreferrer"
        className="fs15 ps-2 me-3"
      >
        {t('LEARN_MORE')}
      </a>
      <span
        className="ico-cross fs12 pointer"
        onClick={dismiss}
      ></span>
    </div>
  )
}
