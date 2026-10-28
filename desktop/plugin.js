/**
 * hermes-vitals-light — a status-bar chip with the CPU, load average, free RAM, CPU
 * pressure (Linux PSI, omitted elsewhere) and RTT of the server the Desktop is connected to
 * ("CPU 23% · Load 1.20 · 3.8G free · waited 15s/60 · RTT 12 ms"), detail in the tooltip.
 * The chip colour comes from the waited verdict and free RAM, not from CPU % or load.
 *
 * The figures come from the backend half (`dashboard/plugin_api.py`,
 * GET /stats), which runs inside the connected `hermes serve`: on a remote
 * gateway it measures the remote box. RTT is measured by this half over the
 * live gateway socket (`host.request('ping')`). Without that half on the
 * server the chip shows "CPU —" and the poll backs off.
 *
 * Settings ▸ Plugins ▸ Hermes Vitals Light switches each figure on or off in the chip and
 * sets the refresh period, 1 s to 1 min, 3 s by default (persisted with ctx.storage); the tooltip has the full detail of what is
 * measured. Clients and Hermes processes switched off are not measured at all:
 * the poll asks the backend to skip them.
 *
 * Edit this file, then `node scripts/build.mjs`: load.js is inlined to give
 * the single plugin.js the runtime loader accepts.
 */

import { atom, Codicon, host, STATUSBAR_AREAS, Tip, ToggleRow, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useSyncExternalStore } from 'react'

const VERDICT_COLOR = { busy: '#f59e0b', ok: undefined, stuck: '#ef4444' }

const LOADING = { status: 'loading' }

// A ping that misses its deadline leaves RTT out; the figures keep their own cadence.
const RTT_TIMEOUT_MS = 2000

// What went wrong, for the tooltip. A 404 is permanent until the backend is
// changed; a timeout is usually the whole box being busy, not this plugin.
function errorKind(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status)

  if (status === 401 || status === 403 || status === 404) {
    return 'missing'
  }

  if (status === 502 || status === 503 || status === 504) {
    return 'offline'
  }

  if (status >= 500 && status < 600) {
    return 'server'
  }

  const message = String(error?.message ?? error ?? '')

  if (/\b40[134]\b/.test(message)) {
    return 'missing'
  }

  // An SSH tunnel that died, a refused connection or a connection id the
  // Desktop dropped: the installation is stopped or reconnecting, not slow.
  if (
    /no connection|econnrefused|econnreset|ehostunreach|enetunreach|enotfound|eai_again|socket hang up|network error|fetch failed|failed to fetch|connection refused|connection closed|not connected|offline|ssh operation|half-open|reconnecting/i.test(
      message
    )
  ) {
    return 'offline'
  }

  return /timeout|timed out|abort|ETIMEDOUT/i.test(message) ? 'timeout' : 'network'
}

// The first icon of the chip doubles as its health light: pulse normally, a
// watch when Hermes is slow, a clock on timeout, a severed link when the
// backend is stopped/unreachable, a plug when the backend half is missing.
const WARNING_COLOR = '#f59e0b'
const OFFLINE_COLOR = '#ef4444'

function chipIcon(state) {
  if (state.status === 'unavailable' || state.status === 'stale') {
    if (state.error?.kind === 'missing') {
      return { color: WARNING_COLOR, name: 'plug' }
    }

    if (state.error?.kind === 'offline' || state.error?.kind === 'network') {
      return { color: OFFLINE_COLOR, name: 'debug-disconnect' }
    }

    if (state.error?.kind === 'timeout') {
      return { color: WARNING_COLOR, name: 'clock' }
    }

    return { color: WARNING_COLOR, name: 'warning' }
  }

  if (Number.isFinite(state.durationMs) && state.durationMs >= SLOW_REQUEST_MS) {
    return { color: WARNING_COLOR, name: 'watch' }
  }

  return { name: 'pulse' }
}

// `prefs`: the counts switched off are not measured on the server either (`?skip=`).
// `interval`: the refresh period in seconds, read at every reschedule so a change applies at once.
function createLoadStore(ctx, prefs, interval) {
  const pollMs = () => Math.max(500, interval.get() * 1000)
  const listeners = new Set()
  let state = LOADING
  let failures = 0
  // Bumped on every connection/profile switch so a reply from the previous
  // server can never paint over the new one.
  let generation = 0
  let cancelTimer = () => {}

  const set = next => {
    state = next
    listeners.forEach(fn => fn())
  }

  const schedule = ms => {
    cancelTimer()
    cancelTimer = ctx.setTimeout(poll, ms)
  }

  // A failed poll keeps the last figures: a timeout must not erase a reading
  // that was valid a moment ago. Only a cold start shows `CPU —`.
  const failed = (error, durationMs) => {
    if (state.stats) {
      set({ ...state, durationMs, error, status: 'stale' })
    } else {
      set({ durationMs, error, status: 'unavailable' })
    }
  }

  // RTT is a gateway `ping` over the live WebSocket, timed here. It runs after the
  // figures paint, so a slow or half-open socket never delays the chip; the next poll
  // still replaces the state, which drops a late reply.
  const measureRtt = (stats, mine) => {
    if (!prefs.get().rtt || typeof host.request !== 'function') {
      return
    }

    const started = performance.now()

    try {
      host.request('ping', {}, RTT_TIMEOUT_MS).then(
        () => {
          if (mine !== generation || !prefs.get().rtt || state.status !== 'ok' || state.stats !== stats) {
            return
          }

          set({ ...state, stats: { ...stats, rtt_ms: performance.now() - started } })
        },
        () => {} // no gateway or no answer: the chip simply has no RTT
      )
    } catch {
      // A host without the RPC door: leave RTT out, as above.
    }
  }

  async function poll() {
    if (typeof document !== 'undefined' && document.hidden) {
      schedule(pollMs())

      return
    }

    const mine = generation
    const startedAt = Date.now()

    try {
      const stats = await ctx.rest(statsPath(prefs.get()), { timeoutMs: REQUEST_TIMEOUT_MS })
      const durationMs = Date.now() - startedAt

      if (mine !== generation) {
        return
      }

      if (stats?.ok) {
        failures = 0
        set({ durationMs, stats, status: 'ok', updatedAt: Date.now() })
        measureRtt(stats, mine)
      } else {
        failures++
        failed({ kind: 'backend' }, durationMs)
      }
    } catch (error) {
      if (mine !== generation) {
        return
      }

      failures++
      failed({ kind: errorKind(error), message: String(error?.message ?? error ?? '') }, Date.now() - startedAt)
    }

    schedule(nextPollDelay(failures, pollMs()))
  }

  // `clear`: a new route means the old server's figures must not be shown;
  // coming back to a visible window keeps them while the fresh poll runs.
  const restart = (clear = true) => {
    generation++
    failures = 0

    if (clear) {
      set(LOADING)
    }

    schedule(0)
  }

  // Both atoms call back immediately on subscribe; that first call starts the loop.
  let started = false

  const onRouteChange = () => {
    if (started) {
      restart()
    }
  }

  ctx.onDispose(host.state.connectionId.subscribe(onRouteChange))
  ctx.onDispose(host.state.profile.subscribe(onRouteChange))
  // A new period re-arms the pending timer now, instead of after the old wait.
  ctx.onDispose(
    interval.subscribe(() => {
      if (started) {
        schedule(pollMs())
      }
    })
  )

  // A window that comes back into view should not wait for the old timer
  // (which may be a long backoff after a failure).
  const onVisibility = () => {
    if (started && !document.hidden) {
      restart(false)
    }
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibility)
    ctx.onDispose(() => document.removeEventListener('visibilitychange', onVisibility))
  }

  ctx.onDispose(() => cancelTimer())
  started = true
  restart()

  return {
    get: () => state,
    subscribe: fn => {
      listeners.add(fn)

      return () => listeners.delete(fn)
    }
  }
}

const CHIP_CLASS =
  'inline-flex h-full shrink-0 items-center gap-1 whitespace-nowrap px-1.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)'

// Error/offline tooltips are deliberately compact: a title and one reason.
// The last figures are still on the chip; the full detail is for healthy polls.
function problemTip(state) {
  const [title, detail] = problemLines(state)

  return jsx('div', {
    className: 'flex max-w-64 flex-col gap-0.5 leading-[1.35]',
    children: [
      jsx('div', { className: 'font-medium', children: title }),
      jsx('div', { className: 'font-normal opacity-80', children: detail })
    ]
  })
}

function LoadChip({ prefs, store }) {
  const state = useSyncExternalStore(store.subscribe, store.get)
  const shown = useValue(prefs)

  if (state.status === 'loading') {
    return null
  }

  const icon = chipIcon(state)
  const iconNode = jsx(Codicon, {
    name: icon.name,
    size: '0.7rem',
    style: icon.color ? { color: icon.color } : undefined
  })

  if (state.status === 'unavailable') {
    // The health icon carries the reason; keep the badge itself short.
    const label = 'CPU —'

    return jsx(Tip, {
      label: problemTip(state),
      children: jsxs('span', {
        className: CHIP_CLASS,
        children: [iconNode, jsx('span', { children: label })]
      })
    })
  }

  const { stats } = state
  const stale = state.status === 'stale'
  // Every figure switched off still leaves the icon, so the tooltip stays reachable.
  const label = chipLabel(stats, shown)
  const detail = stale
    ? problemTip(state)
    : jsx('div', {
        className: 'flex flex-col gap-0.5 tabular-nums',
        children: [...statusLines(state), ...tooltipLines(stats)].map((line, index) =>
          jsx('div', { children: line }, `${index}:${line}`)
        )
      })

  return jsx(Tip, {
    label: detail,
    children: jsxs('span', {
      className: CHIP_CLASS,
      style: { color: VERDICT_COLOR[waitedVerdict(stats)] },
      children: [iconNode, label ? jsx('span', { style: stale ? { opacity: 0.55 } : undefined, children: label }) : null]
    })
  })
}

const formatInterval = seconds => (seconds < 60 ? `${seconds} s` : `${seconds / 60} min`)

function IntervalRow({ interval, setPeriod }) {
  const seconds = useValue(interval)

  return jsxs('label', {
    className: 'flex items-center justify-between gap-4 py-2 text-sm',
    children: [
      jsxs('span', {
        className: 'flex flex-col',
        children: [
          jsx('span', { children: 'Refresh every' }),
          jsx('span', {
            className: 'text-xs text-(--ui-text-tertiary)',
            children: 'How often the chip asks the server for fresh figures (paused while the window is hidden).'
          })
        ]
      }),
      jsx('select', {
        className: 'rounded border border-(--ui-border) bg-transparent px-2 py-1 text-sm',
        onChange: event => setPeriod(Number(event.target.value)),
        value: seconds,
        children: INTERVALS.map(value => jsx('option', { value, children: formatInterval(value) }, value))
      })
    ]
  })
}

function ChipSettings({ interval, prefs, setPeriod, update }) {
  const shown = useValue(prefs)

  return jsxs('div', {
    children: [
      jsx(IntervalRow, { interval, setPeriod }),
      ...CHIP_FIGURES.map(({ description, id, label }) =>
        jsx(ToggleRow, { checked: shown[id], description, label, onChange: on => update({ [id]: on }) }, id)
      )
    ]
  })
}

export default {
  id: 'hermes-vitals-light',
  name: 'Hermes Vitals Light',
  description: 'CPU and RAM of the connected Hermes server, as a status-bar chip.',
  defaultEnabled: false,
  register(ctx) {
    const prefs = atom(shownFigures(ctx.storage?.get('chip', {})))
    const interval = atom(refreshInterval(ctx.storage?.get('interval', undefined)))
    const store = createLoadStore(ctx, prefs, interval)

    const update = patch => {
      prefs.set({ ...prefs.get(), ...patch })
      ctx.storage?.set('chip', prefs.get())
    }

    const setPeriod = seconds => {
      interval.set(refreshInterval(seconds))
      ctx.storage?.set('interval', interval.get())
    }

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 90,
      render: () => jsx(LoadChip, { prefs, store })
    })

    // Feature-detected: older hosts have no Settings ▸ Plugins page, the chip shows everything.
    ctx.registerSettingsPage?.({
      id: 'settings',
      title: 'Hermes Vitals Light',
      icon: 'pulse',
      render: () => jsx(ChipSettings, { interval, prefs, setPeriod, update })
    })
  }
}

// ── inlined from src/load.js ──
// Pure helpers for the status-bar chip: formatting, severity, poll cadence.
// Kept DOM- and SDK-free so the tests import it directly.

const POLL_MS = 3000
const MAX_BACKOFF_MS = 30_000
// A slow backend is still worth waiting for once; the chip shows the last
// reading meanwhile, so a generous timeout costs no freshness.
const REQUEST_TIMEOUT_MS = 8000
// A healthy /stats answers in well under 100 ms; any second spent waiting is
// the connection or the backend struggling, not the figures themselves.
const SLOW_REQUEST_MS = 1500

// The refresh periods the settings offer, in seconds; the default is the 3 s cadence.
const INTERVALS = [1, 3, 5, 10, 30, 60]
const DEFAULT_INTERVAL = POLL_MS / 1000

// A saved period if it is one we offer, else the default.
function refreshInterval(saved) {
  return INTERVALS.includes(saved) ? saved : DEFAULT_INTERVAL
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '?'
  }

  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }

  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`
}

function formatPercent(percent) {
  return Number.isFinite(percent) ? `${Math.round(percent)}%` : '—'
}

function formatRtt(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return '—'
  }

  return ms < 1 ? '<1 ms' : `${Math.round(ms)} ms`
}

// Available RAM in GiB, exactly as the chip shows it: "3.8G free".
function formatFree(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '?'
  }

  return `${(bytes / 1024 ** 3).toFixed(1)}G free`
}

// Linux PSI CPU pressure: round(avg60 * 0.6) seconds of the last minute waited on CPU.
function waitedLabel(stats) {
  const seconds = stats.waited?.seconds

  return Number.isFinite(seconds) ? `waited ${Math.round(seconds)}s/60` : ''
}

const WAITED_STUCK_SECONDS = 25
const WAITED_BUSY_SECONDS = 10
const LOW_FREE_BYTES = 1024 * 1024 ** 2

function waitedVerdict(stats) {
  const verdict = stats.waited?.verdict

  if (verdict === 'stuck' || verdict === 'busy' || verdict === 'ok') {
    return verdict
  }

  const seconds = stats.waited?.seconds
  const free = stats.free

  if ((Number.isFinite(seconds) && seconds >= WAITED_STUCK_SECONDS) || (Number.isFinite(free) && free < LOW_FREE_BYTES)) {
    return 'stuck'
  }

  return Number.isFinite(seconds) && seconds >= WAITED_BUSY_SECONDS ? 'busy' : 'ok'
}

// What the chip can show, in chip order; each one is a switch in the settings page.
// `tui: false`: the TUI card has no server to ask, so it does not offer the figure.
const CHIP_FIGURES = [
  { description: 'CPU use since the previous poll.', id: 'cpu', label: 'CPU' },
  { description: '1-minute load average (servers that report one).', id: 'load', label: 'Load average' },
  {
    description: 'Free memory (MemAvailable on Linux, available RAM on macOS/Windows).',
    id: 'ram',
    label: 'RAM'
  },
  {
    description: 'Seconds in the last minute at least one task waited for CPU (Linux PSI).',
    id: 'waited',
    label: 'Waited on CPU'
  },
  {
    description: 'Round-trip time to the connected server (WebSocket ping).',
    id: 'rtt',
    label: 'RTT',
    tui: false
  },
  {
    description: '👥 sessions active in the last 5 minutes on the connected server (Hermes status).',
    id: 'clients',
    label: 'Active sessions',
    tui: false
  },
  { description: '⚙ Hermes executables running on the server.', id: 'processes', label: 'Hermes processes' }
]

const ALL_SHOWN = Object.fromEntries(CHIP_FIGURES.map(({ id }) => [id, true]))

// Saved prefs over the defaults, so a figure added later starts shown.
function shownFigures(saved) {
  const shown = { ...ALL_SHOWN }

  for (const id of Object.keys(ALL_SHOWN)) {
    if (typeof saved?.[id] === 'boolean') {
      shown[id] = saved[id]
    }
  }

  return shown
}

// The counts the backend skips measuring when they are hidden (the load figures cost nothing).
const SERVER_SIDE = ['clients', 'processes']

function skippedFigures(shown) {
  return SERVER_SIDE.filter(id => !shown[id])
}

// A backend older than `?skip` ignores it and measures everything, as before.
function statsPath(shown) {
  const skip = skippedFigures(shown)

  return skip.length ? `/stats?skip=${skip.join(',')}` : '/stats'
}

function chipLabel(stats, shown = ALL_SHOWN) {
  const parts = []

  if (shown.cpu) {
    parts.push(`CPU ${formatPercent(stats.cpu_percent)}`)
  }

  if (shown.load && Number.isFinite(stats.load_avg?.[0])) {
    parts.push(`Load ${stats.load_avg[0].toFixed(2)}`)
  }

  if (shown.ram) {
    parts.push(Number.isFinite(stats.free) ? formatFree(stats.free) : `RAM ${formatPercent(stats.memory?.percent)}`)
  }

  if (shown.waited) {
    const waited = waitedLabel(stats)
    if (waited) {
      parts.push(waited)
    }
  }

  // Measured by the Desktop half: no gateway socket, no RTT.
  if (shown.rtt && Number.isFinite(stats.rtt_ms)) {
    parts.push(`RTT ${formatRtt(stats.rtt_ms)}`)
  }

  // An older backend half sends no `clients`: keep the chip as it was.
  if (shown.clients && Number.isInteger(stats.clients?.total)) {
    parts.push(`👥 ${stats.clients.total}`)
  }

  // Same for `processes`: Hermes executables running on the server.
  if (shown.processes && Number.isInteger(stats.processes?.total)) {
    parts.push(`⚙ ${stats.processes.total}`)
  }

  return parts.join(' · ')
}

// A server without the backend half answers 404 on every poll; back off instead of
// hammering it, and recover at the normal cadence on the first success.
function nextPollDelay(failures, baseMs = POLL_MS) {
  return failures === 0 ? baseMs : Math.min(baseMs * 2 ** failures, Math.max(MAX_BACKOFF_MS, baseMs))
}

const ERROR_TEXT = {
  backend: "The backend half could not read this machine's load (psutil unavailable).",
  missing: 'The backend half is not answering: enable hermes-vitals-light on this server, then restart its backend.',
  network: 'The Hermes backend is unreachable.',
  offline: 'The Hermes backend is unreachable (stopped or reconnecting).',
  server: 'The Hermes backend answered with an error.',
  timeout: 'The Hermes backend did not answer in time.'
}

function errorText(kind, showingLast = false) {
  const text = ERROR_TEXT[kind] ?? ERROR_TEXT.network

  return showingLast ? `${text} Showing the last reading.` : text
}

// Short, stable age labels for the tooltip: "just now", "12 s", "3 min", "2 h".
function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 5000) {
    return 'just now'
  }

  if (ms < 60_000) {
    return `${Math.max(1, Math.round(ms / 1000))} s`
  }

  if (ms < 3_600_000) {
    return `${Math.max(1, Math.round(ms / 60_000))} min`
  }

  return `${Math.max(1, Math.round(ms / 3_600_000))} h`
}

// A poll duration for the chip and tooltip: "420 ms", "2.5 s", "12 s".
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return '?'
  }

  if (ms < 1000) {
    return `${Math.round(ms)} ms`
  }

  const seconds = ms / 1000

  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`
}

// The tooltip lines that explain why the figures are old, or why there are none.
function statusLines(state, now = Date.now()) {
  const lines = []

  if (state.status === 'stale') {
    const age = formatAge(now - state.updatedAt)

    lines.push(age === 'just now' ? 'Last update: just now' : `Last update: ${age} ago`)
    lines.push(errorText(state.error?.kind, true))
  } else if (state.status === 'unavailable') {
    lines.push(errorText(state.error?.kind))
    lines.push('Retrying automatically.')
  } else if (state.status === 'ok' && Number.isFinite(state.durationMs) && state.durationMs >= SLOW_REQUEST_MS) {
    lines.push(`Hermes is slow: the last poll took ${formatDuration(state.durationMs)}.`)
  }

  if (
    state.error?.kind === 'timeout' &&
    Number.isFinite(state.durationMs) &&
    state.durationMs >= SLOW_REQUEST_MS
  ) {
    lines.push(`The last attempt took ${formatDuration(state.durationMs)}.`)
  }

  return lines
}

const PROBLEM_TITLE = {
  backend: 'Cannot read system load',
  missing: 'Backend plugin missing',
  network: 'Hermes backend offline',
  offline: 'Hermes backend offline',
  server: 'Hermes backend error',
  timeout: 'Hermes backend timed out'
}

// Two short lines for an error tooltip: a title and one compact reason line.
// The detailed figures stay on the chip; the tooltip is about the problem.
function problemLines(state, now = Date.now()) {
  const kind = state.error?.kind
  const title = PROBLEM_TITLE[kind] ?? 'Hermes backend unavailable'

  if (state.status === 'unavailable') {
    if (kind === 'missing') {
      return [title, 'Enable hermes-vitals-light, then restart.']
    }

    if (kind === 'offline' || kind === 'network') {
      return [title, 'Stopped or reconnecting.']
    }

    if (kind === 'timeout') {
      const took =
        Number.isFinite(state.durationMs) && state.durationMs >= SLOW_REQUEST_MS
          ? `No answer after ${formatDuration(state.durationMs)}.`
          : 'No answer from the server.'

      return [title, took]
    }

    if (kind === 'backend') {
      return [title, 'psutil unavailable on the server.']
    }

    return [title, 'The server answered with an error.']
  }

  const age = formatAge(now - state.updatedAt)
  const reading = age === 'just now' ? 'Last reading just now' : `Last reading ${age} ago`

  if (kind === 'missing') {
    return [title, `${reading} · enable and restart`]
  }

  if (kind === 'offline' || kind === 'network') {
    return [title, `${reading} · stopped or reconnecting`]
  }

  if (kind === 'timeout') {
    const took =
      Number.isFinite(state.durationMs) && state.durationMs >= SLOW_REQUEST_MS
        ? ` · last attempt ${formatDuration(state.durationMs)}`
        : ''

    return [title, `${reading}${took}`]
  }

  if (kind === 'backend') {
    return [title, `${reading} · psutil unavailable`]
  }

  return [title, reading]
}

function tooltipLines(stats) {
  const lines = []

  if (stats.hostname) {
    lines.push(stats.hostname)
  }

  lines.push(`CPU ${formatPercent(stats.cpu_percent)}${stats.cpu_count ? ` · ${stats.cpu_count} cores` : ''}`)

  if (Array.isArray(stats.load_avg)) {
    lines.push(`Load ${stats.load_avg.join(' / ')}`)
  }

  const memory = stats.memory
  const free = Number.isFinite(stats.free) ? formatFree(stats.free) : ''

  if (memory) {
    lines.push(
      `RAM ${formatBytes(memory.used)} / ${formatBytes(memory.total)} (${formatPercent(memory.percent)})${free ? ` · ${free}` : ''}`
    )
  } else if (free) {
    lines.push(`Free RAM: ${free}`)
  }

  if (Number.isFinite(stats.waited?.seconds)) {
    lines.push(`Waited on CPU: ${Math.round(stats.waited.seconds)}s/60 (${stats.waited.verdict ?? waitedVerdict(stats)})`)
  }

  if (Number.isFinite(stats.rtt_ms)) {
    lines.push(`RTT ${formatRtt(stats.rtt_ms)}`)
  }

  const bySurface = Object.entries(stats.clients?.by_surface ?? {})

  if (Number.isInteger(stats.clients?.total)) {
    // `by_surface` only comes from a backend half older than the /api/status count.
    lines.push(
      bySurface.length
        ? `Clients: ${bySurface.map(([surface, count]) => `${surface} ${count}`).join(' · ')}`
        : `Active sessions: ${stats.clients.total}`
    )
  }

  const byCommand = Object.entries(stats.processes?.by_command ?? {})

  if (Number.isInteger(stats.processes?.total)) {
    lines.push(
      byCommand.length
        ? `Hermes running: ${byCommand.map(([command, count]) => `${command} ${count}`).join(' · ')}`
        : 'Hermes running: none'
    )
  }

  return lines
}
