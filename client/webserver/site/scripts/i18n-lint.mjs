#!/usr/bin/env node
// i18n-lint — verify every key in src/i18n/en-US.json has at least one
// static `t('KEY')` reference in the frontend source, and every
// `t('KEY')` call references a key that exists in the JSON.
//
// Rationale: before CL-I18N-NAMING, en-US.json had accumulated 22
// orphan keys (zero t() call sites) from UI ports dropping references
// without pruning. The mirror case — `t('KEY')` where KEY is absent
// from JSON — falls back to the literal key at runtime, which hides
// bugs like the `24H_VOL` mistranslation fixed as a drive-by in
// CL-I18N-NAMING. This lint is the guard rail.
//
// Dynamic `t(variable)` call sites can't be resolved by static
// scanning. They're listed in `i18n-lint-allowlist.json` alongside
// the set of keys those dynamic paths may construct. If the allowlist
// declares a key that isn't present in en-US.json, that's treated as
// a missing-key violation too.
//
// Usage:
//   node scripts/i18n-lint.mjs              # check; exit 1 on any violation
//   node scripts/i18n-lint.mjs --list-dynamic   # print every dynamic t() call site
//                                               (useful when updating the allowlist)
//   node scripts/i18n-lint.mjs --print-orphans  # one orphan key per line, stdout
//                                               (machine-readable for cleanup scripts)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const siteRoot = resolve(__dirname, '..')
const jsonPath = resolve(siteRoot, 'src/i18n/en-US.json')
const srcRoot = resolve(siteRoot, 'src')
const allowlistPath = resolve(__dirname, 'i18n-lint-allowlist.json')

const args = new Set(process.argv.slice(2))
const listDynamic = args.has('--list-dynamic')
const printOrphans = args.has('--print-orphans')

// --- load inputs ---
/** @type {Record<string,string>} */
const json = JSON.parse(readFileSync(jsonPath, 'utf8'))
const jsonKeys = new Set(Object.keys(json))

const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
const allowlistCallSites = new Set(allowlist.dynamicCallSites ?? [])
// `referencedKeys` is an object of { groupName: string[] } — groups are
// decorative (they let humans see which dynamic site owns which keys).
// The linter flattens them into a single set.
const allowlistReferencedKeys = new Set(
  Object.values(allowlist.referencedKeys ?? {}).flat()
)

// --- walk source tree ---
/** @returns {string[]} list of .ts/.tsx file paths (absolute) */
function walkSources (dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walkSources(full))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

const sourceFiles = walkSources(srcRoot)

/**
 * Replace JS/TS comments with space (preserving line numbers and offsets so
 * the caller's positional math still works). Handles:
 *   - `//` line comments — respecting single/double/backtick-delimited strings
 *     so `'// url'` isn't mistaken for a comment start.
 *   - `/* ... * /` block comments — same string-aware logic.
 * No template-literal interpolation awareness is needed because we only care
 * about finding `//` and `/*` delimiters, not parsing expressions.
 *
 * Without this, comment lines like ``// `t('X')` → foo`` produce false-
 * positive "missing key X" reports.
 * @param {string} src
 */
function stripComments (src) {
  const out = Array.from(src)
  const len = out.length
  let i = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  while (i < len) {
    const c = out[i]
    if (inSingle) {
      if (c === '\\') { i += 2; continue }
      if (c === "'") inSingle = false
      i++; continue
    }
    if (inDouble) {
      if (c === '\\') { i += 2; continue }
      if (c === '"') inDouble = false
      i++; continue
    }
    if (inBacktick) {
      if (c === '\\') { i += 2; continue }
      if (c === '`') inBacktick = false
      i++; continue
    }
    if (c === "'") { inSingle = true; i++; continue }
    if (c === '"') { inDouble = true; i++; continue }
    if (c === '`') { inBacktick = true; i++; continue }
    if (c === '/' && out[i + 1] === '/') {
      while (i < len && out[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '/' && out[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < len && !(out[i] === '*' && out[i + 1] === '/')) {
        if (out[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < len) { out[i] = ' '; out[i + 1] = ' '; i += 2 }
      continue
    }
    i++
  }
  return out.join('')
}

// --- extract t() call sites ---
// Static form: t('KEY', ...)  — word-boundary + single-quoted first arg.
//   Excludes `.t('...')` method calls (word-boundary blocks the `.` prefix).
//   Codebase uses single quotes exclusively for string literals in t() calls
//   (verified by grep — no `t("..."`) or `t(\`...\`)` uses exist).
const STATIC_RE = /\bt\(\s*'([^'\n]+)'/g
// Dynamic form: t(<identifier-start>, ...) — anything that isn't a literal string.
//   The identifier-start character class avoids matching `t(` followed by `'`/`"`/``.
const DYNAMIC_RE = /\bt\(\s*[A-Za-z_$]/g

/** keys referenced via static t('KEY') calls, with one example call site each */
const staticKeys = new Map() // key -> "relPath:lineNo"
/** dynamic t(var) call sites found in source */
const dynamicSites = [] // [{ site: "relPath:lineNo", sample: "source line" }]

for (const file of sourceFiles) {
  const raw = readFileSync(file, 'utf8')
  // Blank out comments so `// t('X')` examples in doc comments don't
  // look like real call sites. Line numbers/offsets stay stable.
  const text = stripComments(raw)
  const lines = raw.split('\n') // keep raw for the dynamic-site sample display
  const rel = relative(siteRoot, file)

  // Build a cumulative offset -> line-number lookup for regex match positions.
  /** offset of each line's first char */
  const lineStarts = [0]
  for (let i = 0; i < lines.length - 1; i++) {
    lineStarts.push(lineStarts[i] + lines[i].length + 1)
  }
  /** @param {number} off */
  const lineOf = (off) => {
    let lo = 0; let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= off) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  for (const m of text.matchAll(STATIC_RE)) {
    const key = m[1]
    const ln = lineOf(m.index)
    if (!staticKeys.has(key)) staticKeys.set(key, `${rel}:${ln}`)
  }
  for (const m of text.matchAll(DYNAMIC_RE)) {
    const ln = lineOf(m.index)
    dynamicSites.push({ site: `${rel}:${ln}`, sample: lines[ln - 1].trim() })
  }
}

// --- listDynamic mode: print then exit 0 ---
if (listDynamic) {
  console.log(`# dynamic t() call sites (${dynamicSites.length})`)
  for (const { site, sample } of dynamicSites) {
    const marked = allowlistCallSites.has(site) ? ' (allowlisted)' : ' (NEW — add to allowlist)'
    console.log(`  ${site}${marked}`)
    console.log(`      ${sample}`)
  }
  process.exit(0)
}

// --- compute violations ---
/** keys in JSON with no static reference AND not in the allowlist */
const orphans = [...jsonKeys]
  .filter(k => !staticKeys.has(k) && !allowlistReferencedKeys.has(k))
  .sort()

// --- printOrphans mode: one key per line on stdout, exit 0 ---
if (printOrphans) {
  for (const k of orphans) console.log(k)
  process.exit(0)
}

/** static t('KEY') calls where KEY isn't in JSON */
const missingStatic = [...staticKeys.keys()]
  .filter(k => !jsonKeys.has(k))
  .sort()
  .map(k => ({ key: k, site: staticKeys.get(k) }))

/** allowlist-claimed keys that aren't in JSON (dynamic-path bugs) */
const missingAllowlist = [...allowlistReferencedKeys]
  .filter(k => !jsonKeys.has(k))
  .sort()

/** allowlist call sites that don't match any dynamic t(var) found in source */
const staleAllowlistSites = [...allowlistCallSites]
  .filter(s => !dynamicSites.some(d => d.site === s))
  .sort()

/** dynamic t(var) sites that aren't in the allowlist */
const unknownDynamicSites = dynamicSites
  .filter(d => !allowlistCallSites.has(d.site))

// --- report ---
let failed = false

if (orphans.length > 0) {
  failed = true
  console.error(`\nORPHAN KEYS (${orphans.length}) — present in en-US.json but no static t('KEY') reference:`)
  for (const k of orphans) console.error(`  ${k}`)
}

if (missingStatic.length > 0) {
  failed = true
  console.error(`\nMISSING KEYS (${missingStatic.length}) — t('KEY') calls reference keys absent from en-US.json (runtime falls back to the literal key):`)
  for (const { key, site } of missingStatic) console.error(`  ${key}  (${site})`)
}

if (missingAllowlist.length > 0) {
  failed = true
  console.error(`\nMISSING ALLOWLIST KEYS (${missingAllowlist.length}) — allowlist declares these keys but en-US.json lacks them:`)
  for (const k of missingAllowlist) console.error(`  ${k}`)
}

if (unknownDynamicSites.length > 0) {
  failed = true
  console.error(`\nUNKNOWN DYNAMIC CALL SITES (${unknownDynamicSites.length}) — dynamic t(variable) constructs not declared in the allowlist:`)
  for (const { site, sample } of unknownDynamicSites) {
    console.error(`  ${site}`)
    console.error(`      ${sample}`)
  }
  console.error('\nEach such site must either be converted to a literal t(\'KEY\') call or registered in scripts/i18n-lint-allowlist.json with the full set of keys it may construct.')
}

if (staleAllowlistSites.length > 0) {
  failed = true
  console.error(`\nSTALE ALLOWLIST ENTRIES (${staleAllowlistSites.length}) — allowlist lists call sites that no longer exist in source:`)
  for (const s of staleAllowlistSites) console.error(`  ${s}`)
}

if (failed) {
  console.error('')
  process.exit(1)
}

console.log(`i18n-lint: OK  (${jsonKeys.size} keys, ${staticKeys.size} static refs, ${dynamicSites.length} dynamic sites all allowlisted)`)
