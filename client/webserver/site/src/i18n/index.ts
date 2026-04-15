import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// T15: previously imported `./en-US.json` statically, which pulled
// the 85 KB translation table into the main entry chunk (~23% of
// its size). Switched to a dynamic import so webpack splits the
// JSON into its own chunk loaded in parallel with the initial
// render. `App.tsx` awaits `initI18n()` before mounting the router
// -- the 85 KB chunk loads in flight with the first lazy page
// bundle, and the visible delay is just a brief "Loading…" message.
//
// Downside: we no longer get compile-time type checking against
// the JSON keys (it's typed as `any` through the dynamic import),
// but the previous static import also typed it as `any` because
// `en-US.json` doesn't have type-safe resource typing enabled,
// so no net loss.
export async function initI18n (): Promise<void> {
  const enUS = (await import(/* webpackChunkName: "i18n-en-US" */ './en-US.json')).default
  await i18n
    .use(initReactI18next)
    .init({
      resources: {
        'en-US': { translation: enUS }
      },
      lng: 'en-US',
      fallbackLng: 'en-US',
      interpolation: {
        // Uses {{ key }} format matching the existing Go/JS pattern.
        prefix: '{{',
        suffix: '}}',
        escapeValue: false,
      },
    })
}

export default i18n
