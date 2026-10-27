import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALL_SHOWN,
  chipLabel,
  errorText,
  formatAge,
  formatBytes,
  formatDuration,
  formatPercent,
  levelOf,
  loadPercent,
  MAX_BACKOFF_MS,
  nextPollDelay,
  POLL_MS,
  shownFigures,
  shownPercents,
  SLOW_REQUEST_MS,
  stateNote,
  statusLines,
  tooltipLines
} from '../src/load.js'

test('the chip shows CPU, 1-minute load and RAM', () => {
  assert.equal(chipLabel({ cpu_percent: 23.4, load_avg: [1.2, 0.8, 0.5], memory: { percent: 61 } }), 'CPU 23% · Load 1.20 · RAM 61%')
})

test('the chip counts active sessions and the tooltip gives the total', () => {
  const stats = { clients: { total: 4 }, cpu_percent: 5, memory: { percent: 10 } }

  assert.equal(chipLabel(stats), 'CPU 5% · RAM 10% · 👥 4')
  assert.equal(tooltipLines(stats).at(-1), 'Active sessions: 4')
})

test('no active session reads as zero, a server that gives no count shows none at all', () => {
  const idle = { clients: { total: 0 }, cpu_percent: 5, memory: { percent: 10 } }

  assert.equal(chipLabel(idle), 'CPU 5% · RAM 10% · 👥 0')
  assert.equal(tooltipLines(idle).at(-1), 'Active sessions: 0')
  assert.equal(chipLabel({ cpu_percent: 5, memory: { percent: 10 } }), 'CPU 5% · RAM 10%')
})

test('a backend half older than the /api/status count still gets its per-client tooltip', () => {
  const stats = { clients: { by_surface: { bighelp: 1, desktop: 2 }, total: 3 }, cpu_percent: 5, memory: { percent: 10 } }

  assert.equal(tooltipLines(stats).at(-1), 'Clients: bighelp 1 · desktop 2')
})

test('the chip counts running Hermes executables and the tooltip names each command', () => {
  const stats = {
    clients: { total: 0 },
    cpu_percent: 5,
    memory: { percent: 10 },
    processes: { by_command: { chat: 3, serve: 1 }, total: 4 }
  }

  assert.equal(chipLabel(stats), 'CPU 5% · RAM 10% · 👥 0 · ⚙ 4')
  assert.equal(tooltipLines(stats).at(-1), 'Hermes running: chat 3 · serve 1')
  assert.equal(chipLabel({ clients: stats.clients, cpu_percent: 5, memory: { percent: 10 } }), 'CPU 5% · RAM 10% · 👥 0')
})

test('the chip shows only the switched-on figures, and only those colour it', () => {
  const stats = {
    clients: { total: 2 },
    cpu_count: 4,
    cpu_percent: 95,
    load_avg: [1, 1, 1],
    memory: { percent: 10 },
    processes: { by_command: {}, total: 3 }
  }
  const shown = shownFigures({ cpu: false, processes: false })

  assert.equal(chipLabel(stats, shown), 'Load 1.00 · RAM 10% · 👥 2')
  assert.equal(levelOf(...shownPercents(stats, shown)), 'normal')
  assert.equal(levelOf(...shownPercents(stats)), 'critical')
})

test('saved settings fill in defaults and ignore junk', () => {
  assert.deepEqual(shownFigures(undefined), ALL_SHOWN)
  assert.deepEqual(shownFigures({ bogus: false, ram: 'no', load: false }), { ...ALL_SHOWN, load: false })
})

test('a server that reports no load average keeps a CPU + RAM chip', () => {
  assert.equal(chipLabel({ cpu_percent: 5, memory: { percent: 10 } }), 'CPU 5% · RAM 10%')
})

test('load is weighed per core, so a saturated box colours the chip', () => {
  const stats = { cpu_count: 4, load_avg: [3.8, 2, 1] }

  assert.equal(loadPercent(stats), 95)
  assert.equal(levelOf(10, loadPercent(stats), 20), 'critical')
  assert.equal(loadPercent({ load_avg: [1, 1, 1] }), undefined)
})

test('bytes read in binary units, one decimal below 10', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(3.5 * 1024 ** 3), '3.5 GB')
  assert.equal(formatBytes(16 * 1024 ** 3), '16 GB')
  assert.equal(formatBytes(undefined), '?')
})

test('a missing percent shows a dash, never NaN%', () => {
  assert.equal(formatPercent(23.4), '23%')
  assert.equal(formatPercent(undefined), '—')
})

test('the chip takes the colour of its worst figure', () => {
  assert.equal(levelOf(10, 50), 'normal')
  assert.equal(levelOf(80, 20), 'warning')
  assert.equal(levelOf(20, 95), 'critical')
  assert.equal(levelOf(undefined, undefined), 'normal')
})

test('polling backs off on failure, capped, and resets on success', () => {
  assert.equal(nextPollDelay(0), POLL_MS)
  assert.ok(nextPollDelay(1) > POLL_MS)
  assert.equal(nextPollDelay(50), MAX_BACKOFF_MS)
  assert.equal(MAX_BACKOFF_MS, 30_000)
})

test('ages read as just now, seconds, minutes or hours', () => {
  assert.equal(formatAge(1000), 'just now')
  assert.equal(formatAge(12_000), '12 s')
  assert.equal(formatAge(3 * 60_000), '3 min')
  assert.equal(formatAge(2 * 3_600_000), '2 h')
  assert.equal(formatAge(undefined), 'just now')
})

test('durations read in milliseconds or seconds', () => {
  assert.equal(formatDuration(420), '420 ms')
  assert.equal(formatDuration(2500), '2.5 s')
  assert.equal(formatDuration(12_000), '12 s')
  assert.equal(formatDuration(undefined), '?')
  assert.equal(SLOW_REQUEST_MS, 1500)
})

test('a stale chip explains its age and why the figures stopped updating', () => {
  const state = { error: { kind: 'timeout' }, status: 'stale', updatedAt: 1000 }

  assert.deepEqual(statusLines(state, 13_000), [
    'Last update: 12 s ago',
    'The Hermes backend did not answer in time. Showing the last reading.'
  ])
  assert.deepEqual(statusLines({ status: 'stale', updatedAt: 10_000, error: { kind: 'network' } }, 12_000), [
    'Last update: just now',
    'The Hermes backend is unreachable. Showing the last reading.'
  ])
  assert.deepEqual(statusLines({ status: 'stale', updatedAt: 1000, error: { kind: 'offline' } }, 13_000), [
    'Last update: 12 s ago',
    'The Hermes backend is unreachable (stopped or reconnecting). Showing the last reading.'
  ])
})

test('a timed-out attempt names its duration', () => {
  assert.deepEqual(statusLines({ durationMs: 8000, error: { kind: 'timeout' }, status: 'unavailable' }), [
    'The Hermes backend did not answer in time.',
    'Retrying automatically.',
    'The last attempt took 8.0 s.'
  ])
})

test('a slow but successful poll is called out in the tooltip and on the chip', () => {
  assert.deepEqual(statusLines({ durationMs: 2500, status: 'ok' }), ['Hermes is slow: the last poll took 2.5 s.'])
  assert.deepEqual(statusLines({ durationMs: 420, status: 'ok' }), [])
  assert.equal(stateNote({ durationMs: 2500, status: 'ok' }), '2.5 s')
  assert.equal(stateNote({ durationMs: 420, status: 'ok' }), '')
  assert.equal(stateNote({ error: { kind: 'offline' }, status: 'stale' }), 'offline')
  assert.equal(stateNote({ error: { kind: 'network' }, status: 'stale' }), 'offline')
  assert.equal(stateNote({ error: { kind: 'timeout' }, status: 'stale' }), 'timeout')
  assert.equal(stateNote({ error: { kind: 'missing' }, status: 'stale' }), 'plugin')
  assert.equal(stateNote({ error: { kind: 'backend' }, status: 'stale' }), 'error')
})

test('an empty chip has no age, just the error and the retry', () => {
  assert.deepEqual(statusLines({ status: 'loading' }), [])
  assert.deepEqual(statusLines({ status: 'ok', stats: {} }), [])
  assert.deepEqual(statusLines({ error: { kind: 'missing' }, status: 'unavailable' }), [
    errorText('missing'),
    'Retrying automatically.'
  ])
  assert.match(errorText('bogus'), /unreachable/)
})

test('the tooltip names the host and every figure the server sent', () => {
  const lines = tooltipLines({
    cpu_count: 8,
    cpu_percent: 12,
    hostname: 'gw-1',
    load_avg: [0.5, 0.4, 0.3],
    memory: { percent: 50, total: 8 * 1024 ** 3, used: 4 * 1024 ** 3 }
  })

  assert.deepEqual(lines, ['gw-1', 'CPU 12% · 8 cores', 'Load 0.5 / 0.4 / 0.3', 'RAM 4.0 GB / 8.0 GB (50%)'])
})

test('a Windows server without load average still gets a tooltip', () => {
  assert.deepEqual(tooltipLines({ cpu_percent: 5, memory: { percent: 10, total: 1024, used: 102 } }), [
    'CPU 5%',
    'RAM 102 B / 1.0 KB (10%)'
  ])
})
