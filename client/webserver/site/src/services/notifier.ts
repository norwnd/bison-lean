// notifier - severity constants, rich-note token helpers, browser/OS desktop
// notification dispatch, and the localStorage-backed per-host settings used
// by both the SettingsPage UI and the dispatch path. Mirrors dev2
// `client/webserver/site/src/js/notifications.ts`.

import type { CoreNote } from '../stores/types'

export const IGNORE = 0
export const DATA = 1
export const POKE = 2
export const SUCCESS = 3
export const WARNING = 4
export const ERROR = 5

// severityClass maps a numeric severity to the SCSS class name used by
// `.note-indicator` and `#noteIndicator` (main.scss). Values <= POKE have
// no colored indicator (POKE is rendered without a dot in dev2).
export function severityClass (severity: number): string {
  if (severity === SUCCESS) return 'good'
  if (severity === WARNING) return 'warn'
  if (severity >= ERROR) return 'bad'
  return ''
}

// ---- Rich-note token parsing -------------------------------------------------

// The two regexes are kept disjoint - order tokens require the literal
// string "order" before the pipe, coin tokens require the asset ID to be
// digits-only. No span can match both, so the parser doesn't need an
// overlap-resolution pass.
const orderTokenRe = /\{\{\{order\|([^}]+)\}\}\}/g
const coinExplorerTokenRe = /\{\{\{(\d+)\|([^}]+)\}\}\}/g

export type RichSegment =
  | { kind: 'text'; value: string }
  | { kind: 'order'; hash: string }
  | { kind: 'coin'; assetID: number; hash: string }

// parseRichNote splits a Core note `details` string into a sequence of
// text/link segments. The two token shapes mirror dev2's `insertRichNote`:
// `{{{order|HASH}}}` for order links and `{{{ASSETID|COINHASH}}}` for
// coin-explorer links.
export function parseRichNote (s: string): RichSegment[] {
  type Range = { from: number; to: number; seg: RichSegment }
  const ranges: Range[] = []
  let m: RegExpExecArray | null

  orderTokenRe.lastIndex = 0
  while ((m = orderTokenRe.exec(s)) !== null) {
    ranges.push({ from: m.index, to: m.index + m[0].length, seg: { kind: 'order', hash: m[1] } })
  }

  coinExplorerTokenRe.lastIndex = 0
  while ((m = coinExplorerTokenRe.exec(s)) !== null) {
    ranges.push({
      from: m.index,
      to: m.index + m[0].length,
      seg: { kind: 'coin', assetID: Number(m[1]), hash: m[2] },
    })
  }

  ranges.sort((a, b) => a.from - b.from)
  const out: RichSegment[] = []
  let pos = 0
  for (const r of ranges) {
    if (r.from > pos) out.push({ kind: 'text', value: s.slice(pos, r.from) })
    out.push(r.seg)
    pos = r.to
  }
  if (pos < s.length) out.push({ kind: 'text', value: s.slice(pos) })
  return out
}

// plainNote flattens a rich-note string to plain text with shortened hashes,
// for use in browser/OS desktop notifications and popup toasts where rich
// HTML isn't available.
export function plainNote (s: string): string {
  return parseRichNote(s).map(seg => {
    if (seg.kind === 'text') return seg.value
    return seg.hash.slice(0, 8)
  }).join('')
}

// ---- Desktop-notification settings ------------------------------------------

const DEFAULT_NTFN_SETTINGS: Record<string, boolean> = {
  browserNtfnEnabled: false,
  order: true,
  match: true,
  bondpost: true,
  conn: true,
}

export const desktopNtfnTypeLabels: Record<string, string> = {
  order: 'Orders',
  match: 'Matches',
  bondpost: 'Bonds',
  conn: 'Connections',
}

export function desktopNtfnSettingsKey (): string {
  return `desktop_notifications-${window.location.host}`
}

export function loadDesktopNtfnSettings (): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(desktopNtfnSettingsKey())
    if (raw) return { ...DEFAULT_NTFN_SETTINGS, ...(JSON.parse(raw) as Record<string, boolean>) }
  } catch { /* ignore parse errors - fall through to defaults */ }
  return { ...DEFAULT_NTFN_SETTINGS }
}

export function saveDesktopNtfnSettings (settings: Record<string, boolean>): void {
  window.localStorage.setItem(desktopNtfnSettingsKey(), JSON.stringify(settings))
}

// ---- Desktop dispatch (browser + webview + webkit) --------------------------

interface BWHandler {
  postMessage: (args: unknown[]) => void
}

declare global {
  interface Window {
    isWebview?: boolean
    sendOSNotification?: (title: string, body?: string) => Promise<void>
    webkit?: { messageHandlers?: { bwHandler?: BWHandler } }
  }
}

function isDesktopWebview (): boolean {
  return typeof window !== 'undefined' && window.isWebview !== undefined
}

function isDesktopWebkit (): boolean {
  return typeof window !== 'undefined' && Boolean(window.webkit?.messageHandlers?.bwHandler)
}

async function sendOSNotification (title: string, body?: string): Promise<void> {
  if (isDesktopWebview() && window.sendOSNotification) {
    await window.sendOSNotification(title, body)
  } else if (isDesktopWebkit()) {
    window.webkit!.messageHandlers!.bwHandler!.postMessage(['sendOSNotification', title, body])
  }
}

function sendBrowserNotification (title: string, body?: string): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  // eslint-disable-next-line no-new -- the constructor itself fires the notification
  new Notification(title, { body, icon: '/img/softened-icon.png' })
}

// desktopNotify dispatches a single CoreNote to the OS/browser, gated by
// the user's per-host preferences. No-ops silently when disabled or when
// the note type isn't one of the four user-event types covered by the UI
// (order/match/bondpost/conn).
export async function desktopNotify (note: CoreNote): Promise<void> {
  const settings = loadDesktopNtfnSettings()
  if (!settings.browserNtfnEnabled || !settings[note.type]) return
  const title = note.subject
  const body = plainNote(note.details)
  if (isDesktopWebview() || isDesktopWebkit()) {
    await sendOSNotification(title, body)
  } else {
    sendBrowserNotification(title, body)
  }
}

// fireSystemNotification fires a single OS/browser notification directly,
// bypassing the per-host preferences check that `desktopNotify` performs.
// Used by SettingsPage to send a "desktop notifications enabled" confirmation
// the moment the user toggles the global setting on (mirrors dev2
// `BrowserNotifier.requestNtfnPermission`).
export async function fireSystemNotification (title: string, body?: string): Promise<void> {
  if (isDesktopWebview() || isDesktopWebkit()) {
    await sendOSNotification(title, body)
  } else {
    sendBrowserNotification(title, body)
  }
}
