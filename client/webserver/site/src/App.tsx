import { useEffect, useState } from 'react'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import { initI18n } from './i18n'

// T15: async i18n init gate. Previously imported `./i18n` for its
// side effect (static en-US.json import triggered synchronous init).
// The JSON is now lazy-loaded inside `initI18n()` so webpack can
// split it out of the main entry chunk. While the 85 KB translation
// table fetches, we show a tiny flash-of-loading state; after init
// resolves, we mount the router normally. The JSON fetch races the
// first lazy route chunk so the user-visible delay is bounded by
// whichever is slower.
export default function App () {
  const [i18nReady, setI18nReady] = useState(false)
  const [i18nError, setI18nError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    initI18n().then(
      () => { if (!cancelled) setI18nReady(true) },
      (err) => { if (!cancelled) setI18nError(String(err)) }
    )
    return () => { cancelled = true }
  }, [])

  if (i18nError) {
    // Translations unavailable -- without the i18n resource table,
    // every `t(...)` call would fall back to the key literal. That's
    // still readable English, but it also means something fundamental
    // broke (likely a network / static-hosting misconfiguration).
    // Surface the error clearly instead of silently running degraded.
    return (
      <div className="flex-center p-5 text-danger">
        Failed to load translations: {i18nError}
      </div>
    )
  }

  if (!i18nReady) {
    return <div className="flex-center p-5">Loading…</div>
  }

  return <RouterProvider router={router} />
}
