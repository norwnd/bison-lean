<a id="top"/>

Bison Wallet supports translations for the React frontend and the notification messages from the backend.

To add a new locale, the translations must be defined in the following locations:

1. Notification strings (client/core/locale_ntfn.go)
2. React UI strings (client/webserver/site/src/i18n/)

If you decide to do the following for a different language, please see the [Contribution Guide](https://github.com/decred/dcrdex/wiki/Contribution-Guide) for help with the github workflow.

# Step 1 - Notifications

To update the notification translations, add or modify the translation in the appropriate locale dictionary map (e.g `originLocale`, `ptBR`, etc) in the [`client/core/locale_ntfn.go`](https://github.com/decred/dcrdex/blob/master/client/core/locale_ntfn.go) file. These dictionaries maps notification keys to translations. New or modified entries should use the translation in the English dictionary (`var originLocale map[Topic]*translation` in the file `locale_ntfn.go`) as the source text. The goal is to duplicate entries for all keys in the English dictionary.

When creating a dictionary for a new language, use the BCP 47 language tag to construct the map name and its translations should correspond to the English strings in the `originLocale` map in the same file.

Note how in **client/core/locale_ntfn.go** there are "printf" specifiers like `%s` and `%d`.  These define the formatting for various runtime data, such as integer numbers, identifier strings, etc.  Because sentence structure varies between languages the order of those specifiers can be explicitly defined like `%[3]s` (the third argument given to printf in the code) instead of relying on the position of those specifiers in the formatting string.  This is necessary because the code that executes the printing always provides the values in a particular order, which may not be the same order in a translated string.

Once the translations are added to **client/core/locale_ntfn.go**, the new map is listed in the `var locales map[string]map[Topic]*translation` at the bottom of the same file.

# Step 2 - React UI

The React frontend uses [`react-i18next`](https://react.i18next.com/). The translation tables live in [`client/webserver/site/src/i18n/`](https://github.com/decred/dcrdex/tree/master/client/webserver/site/src/i18n) as JSON files — one per locale — loaded by [`index.ts`](https://github.com/decred/dcrdex/blob/master/client/webserver/site/src/i18n/index.ts).

To update the existing English strings, edit `client/webserver/site/src/i18n/en-US.json`. Keys use a `Namespace.KEY` convention (e.g. `Common.ACCEPT`, `MarketsPage.BUY`) so they can be grouped by page or feature. Interpolation placeholders use the `{{ key }}` syntax.

To add a new language:

1. Copy `en-US.json` to a new file named after the BCP 47 language tag — for example `pt-BR.json` — and translate every value, keeping the keys unchanged.
2. Register the new resource bundle in `index.ts` alongside the existing `'en-US'` entry in the `resources` map.
3. The startup language cascade (DB-persisted → `Config.Language` → `en-US`) handles selection automatically; no additional wiring is required for the server to advertise the new locale.

Use `t('Namespace.KEY')` from `react-i18next`'s `useTranslation()` hook in components; avoid constructing keys dynamically unless the set is finite and documented, because static analysis tooling only catches orphan/missing keys for literal `t(...)` call sites.

When testing, rebuild the site assets bundle with `npm ci && npm run build` in **client/webserver/site** — watch mode (`npm run watch`) picks up JSON changes automatically.

---

[⤴ Back to Top](#top)
