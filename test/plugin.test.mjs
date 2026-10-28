// Wiring test: runs the BUILT desktop/plugin.js against a stub SDK/React and a fake
// ctx (rest, timers, dispose), the way the runtime loader would (specifiers rewritten).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function atom(value) {
  const listeners = new Set()

  return {
    get: () => value,
    set(next) {
      value = next
      listeners.forEach(fn => fn(value))
    },
    subscribe(fn) {
      listeners.add(fn)
      fn(value)

      return () => listeners.delete(fn)
    }
  }
}

const connectionId = atom('local')
const profile = atom('default')

const visibilityListeners = new Set()

globalThis.document = {
  addEventListener: (type, fn) => {
    if (type === 'visibilitychange') {
      visibilityListeners.add(fn)
    }
  },
  hidden: false,
  removeEventListener: (type, fn) => {
    if (type === 'visibilitychange') {
      visibilityListeners.delete(fn)
    }
  }
}

function setHidden(hidden) {
  globalThis.document.hidden = hidden
}

function fireVisibility() {
  for (const fn of [...visibilityListeners]) {
    fn()
  }
}

globalThis.__stubs = {
  atom,
  Codicon: 'Codicon',
  host: { state: { connectionId, profile } },
  jsx: (type, props) => ({ props, type }),
  jsxs: (type, props) => ({ props, type }),
  STATUSBAR_AREAS: { right: 'statusBar.right' },
  Tip: 'Tip',
  ToggleRow: 'ToggleRow',
  useSyncExternalStore: (subscribe, snapshot) => snapshot(),
  useValue: store => store.get()
}

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export default', 'globalThis.__plugin =')

new Function(
  'const { atom, Codicon, host, jsx, jsxs, STATUSBAR_AREAS, Tip, ToggleRow, useSyncExternalStore, useValue } = globalThis.__stubs;' +
    source
)()

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function load(rest, saved = {}) {
  const registered = []
  const disposers = []
  const timers = []
  const pages = []

  globalThis.__plugin.register({
    onDispose: fn => disposers.push(fn),
    register: contribution => registered.push(contribution),
    registerSettingsPage: page => pages.push(page),
    rest,
    storage: {
      get: (key, fallback) => (key in saved ? saved[key] : fallback),
      set: (key, value) => (saved[key] = value)
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, live: true, ms }
      timers.push(timer)

      return () => {
        timer.live = false
      }
    }
  })

  const fire = async () => {
    const timer = timers.filter(t => t.live).at(-1)
    timer.live = false
    await timer.fn()
    await settle()
  }

  // Chip render: the contribution yields <LoadChip store>; call it like React would.
  const chip = () => {
    const element = registered[0].render()

    return element.type(element.props)
  }

  // Settings page: <ChipSettings> -> the interval row, then one <ToggleRow> per figure.
  const rows = () => {
    const element = pages[0].render()

    return element.type(element.props).props.children
  }

  const toggles = () => rows().filter(row => row.props.label)

  // <IntervalRow> -> label -> [text, <select>].
  const intervalSelect = () => {
    const row = rows()[0]

    return row.type(row.props).props.children[1]
  }

  return {
    chip,
    dispose: () => disposers.forEach(fn => fn()),
    fire,
    intervalSelect,
    pages,
    registered,
    saved,
    timers,
    toggles
  }
}

function text(node) {
  if (node == null || typeof node !== 'object') {
    return node == null ? '' : String(node)
  }

  const children = node.props?.children

  return Array.isArray(children) ? children.map(text).join('') : text(children)
}

const STATS = {
  cpu_count: 4,
  cpu_percent: 23.4,
  free: 4 * 1024 ** 3,
  hostname: 'gw-1',
  load_avg: [1.5, 1, 0.5],
  memory: { percent: 92, total: 8 * 1024 ** 3, used: 7 * 1024 ** 3 },
  ok: true,
  waited: { seconds: 15, verdict: 'busy' }
}

test('one chip lands in the right status bar and shows nothing before the first reply', () => {
  const plugin = load(() => new Promise(() => {}))

  assert.equal(plugin.registered.length, 1)
  assert.equal(plugin.registered[0].area, 'statusBar.right')
  assert.equal(plugin.chip(), null)
  plugin.dispose()
})

test('a reply from /stats paints every figure, coloured by the waited verdict', async () => {
  const paths = []
  const plugin = load(async path => {
    paths.push(path)

    return STATS
  })

  await plugin.fire()

  const chip = plugin.chip()
  assert.deepEqual(paths, ['/stats'])
  assert.equal(text(chip.props.children), 'CPU 23% · Load 1.50 · 4.0G free · waited 15s/60')
  assert.equal(chip.props.children.props.style.color, '#f59e0b')
  assert.match(text(chip.props.label), /gw-1/)
  assert.match(text(chip.props.label), /Waited on CPU: 15s\/60 \(busy\)/)
  plugin.dispose()
})

test('each figure has a switch in Settings, saved; hiding one keeps the verdict colour', async () => {
  const plugin = load(async () => STATS)

  await plugin.fire()

  const rows = plugin.toggles()
  assert.equal(plugin.pages[0].title, 'Hermes Vitals Light')
  assert.deepEqual(
    rows.map(row => row.props.label),
    ['CPU', 'Load average', 'RAM', 'Waited on CPU', 'Active sessions', 'Hermes processes']
  )
  assert.ok(rows.every(row => row.props.checked))

  rows.find(row => row.props.label === 'RAM').props.onChange(false)

  const chip = plugin.chip()
  assert.equal(text(chip.props.children), 'CPU 23% · Load 1.50 · waited 15s/60')
  assert.equal(chip.props.children.props.style.color, '#f59e0b', 'the RAM figure no longer decides the colour')
  assert.equal(plugin.toggles().find(row => row.props.label === 'RAM').props.checked, false)
  assert.deepEqual(plugin.saved.chip, {
    clients: true,
    cpu: true,
    load: true,
    processes: true,
    ram: false,
    waited: true
  })
  plugin.dispose()
})

test('counts switched off are skipped on the server from the next poll', async () => {
  const paths = []
  const plugin = load(async path => {
    paths.push(path)

    return STATS
  })

  await plugin.fire()
  plugin.toggles().find(row => row.props.label === 'Hermes processes').props.onChange(false)
  await plugin.fire()
  plugin.toggles().find(row => row.props.label === 'Active sessions').props.onChange(false)
  // RAM is one psutil call: hiding it changes nothing server-side.
  plugin.toggles().find(row => row.props.label === 'RAM').props.onChange(false)
  await plugin.fire()

  assert.deepEqual(paths, ['/stats', '/stats?skip=processes', '/stats?skip=clients,processes'])
  plugin.dispose()
})

test('saved settings come back on load, and every figure off leaves the icon', async () => {
  const plugin = load(async () => STATS, {
    chip: { clients: false, cpu: false, load: false, processes: false, ram: false, waited: false }
  })

  await plugin.fire()

  const chip = plugin.chip()
  assert.equal(text(chip.props.children), '')
  assert.equal(chip.props.children.props.children[0].type, 'Codicon')
  assert.match(text(chip.props.label), /gw-1/, 'the tooltip keeps the detail')
  plugin.dispose()
})

test('the refresh period is a setting: saved, applied at once, and the next poll waits that long', async () => {
  const plugin = load(async () => STATS, { interval: 10 })

  assert.equal(plugin.intervalSelect().props.value, 10, 'the saved period comes back')

  await plugin.fire()
  assert.equal(plugin.timers.filter(t => t.live).at(-1).ms, 10_000)

  plugin.intervalSelect().props.onChange({ target: { value: '30' } })
  assert.equal(plugin.saved.interval, 30)
  assert.equal(plugin.timers.filter(t => t.live).at(-1).ms, 30_000, 'the pending wait is replaced')

  // A value we do not offer is ignored.
  plugin.intervalSelect().props.onChange({ target: { value: '7' } })
  assert.equal(plugin.saved.interval, 3)
  plugin.dispose()
})

test('a server without the backend half shows a dash and backs off', async () => {
  const plugin = load(async () => {
    throw new Error('404')
  })

  await plugin.fire()

  assert.equal(text(plugin.chip().props.children), 'CPU — · plugin')
  assert.ok(plugin.timers.at(-1).ms > 3000)
  plugin.dispose()
})

test('a failed poll keeps the last figures, dimmed, with their age and the reason', async () => {
  let calls = 0
  const plugin = load(async () => {
    calls++

    if (calls === 1) {
      return STATS
    }

    throw new Error('Timed out connecting to Hermes backend after 8000ms')
  })

  await plugin.fire()
  await plugin.fire()

  const chip = plugin.chip()
  assert.equal(text(chip.props.children), 'CPU 23% · Load 1.50 · 4.0G free · waited 15s/60 · timeout')
  assert.equal(chip.props.children.props.children[0].props.name, 'clock')
  assert.equal(chip.props.children.props.children[1].props.style.opacity, 0.55)
  assert.match(text(chip.props.label), /Hermes backend timed out/)
  assert.match(text(chip.props.label), /Last reading just now/)
  plugin.dispose()
})

test('a first-poll timeout explains itself instead of claiming the plugin is missing', async () => {
  const plugin = load(async () => {
    throw new Error('Timed out connecting to Hermes backend after 8000ms')
  })

  await plugin.fire()

  const chip = plugin.chip()
  assert.equal(text(chip.props.children), 'CPU — · timeout')
  assert.equal(chip.props.children.props.children[0].props.name, 'clock')
  assert.match(text(chip.props.label), /Hermes backend timed out/)
  assert.match(text(chip.props.label), /No answer from the server/)
  assert.doesNotMatch(text(chip.props.label), /enable hermes-vitals-light/)
  plugin.dispose()
})

test('a stopped backend is explicit, even on a cold start', async () => {
  const plugin = load(async () => {
    throw new Error('No connection with id "iris"')
  })

  await plugin.fire()

  const chip = plugin.chip()
  assert.equal(text(chip.props.children), 'CPU — · offline')
  assert.equal(chip.props.children.props.children[0].props.name, 'debug-disconnect')
  assert.equal(chip.props.children.props.children[0].props.style.color, '#ef4444')
  assert.match(chip.props.label.props.className, /max-w-64/)
  assert.match(text(chip.props.label), /Hermes backend offline/)
  assert.match(text(chip.props.label), /Stopped or reconnecting/)
  plugin.dispose()
})

test('a dead SSH tunnel and a 502 both read as offline, not as lag', async () => {
  for (const error of [
    new Error('SSH operation to hermes-agent@oracle timed out. The connection may be half-open; reconnecting.'),
    Object.assign(new Error('Bad Gateway'), { status: 502 })
  ]) {
    const plugin = load(async () => {
      throw error
    })

    await plugin.fire()

    const chip = plugin.chip()
    assert.equal(text(chip.props.children), 'CPU — · offline')
    assert.equal(chip.props.children.props.children[0].props.name, 'debug-disconnect')
    plugin.dispose()
  }
})

test('a stopped backend keeps the last figures with an offline note', async () => {
  let calls = 0
  const plugin = load(async () => {
    calls++

    if (calls === 1) {
      return STATS
    }

    throw new Error('read ECONNRESET')
  })

  await plugin.fire()
  await plugin.fire()

  const chip = plugin.chip()
  assert.equal(text(chip.props.children), 'CPU 23% · Load 1.50 · 4.0G free · waited 15s/60 · offline')
  assert.equal(chip.props.children.props.children[0].props.name, 'debug-disconnect')
  assert.equal(chip.props.children.props.children[1].props.style.opacity, 0.55)
  assert.match(text(chip.props.label), /Hermes backend offline/)
  assert.match(text(chip.props.label), /Last reading just now/)
  assert.match(text(chip.props.label), /stopped or reconnecting/)
  plugin.dispose()
})

test('a slow successful poll shows a watch icon and its duration', async () => {
  const realNow = Date.now
  let now = 1_000_000
  let plugin

  Date.now = () => now

  try {
    plugin = load(async () => {
      now += 2500

      return STATS
    })

    await plugin.fire()

    const chip = plugin.chip()
    assert.equal(chip.props.children.props.children[0].props.name, 'watch')
    assert.equal(chip.props.children.props.children[0].props.style.color, '#f59e0b')
    assert.match(text(chip.props.children), /2\.5 s$/)
    assert.match(text(chip.props.label), /Hermes is slow: the last poll took 2\.5 s/)
  } finally {
    plugin?.dispose()
    Date.now = realNow
  }
})

test('a 404 still names the missing backend half', async () => {
  const plugin = load(async () => {
    throw Object.assign(new Error('404'), { status: 404 })
  })

  await plugin.fire()

  const chip = plugin.chip()
  assert.equal(text(chip.props.children), 'CPU — · plugin')
  assert.equal(chip.props.children.props.children[0].props.name, 'plug')
  assert.match(text(chip.props.label), /Backend plugin missing/)
  assert.match(text(chip.props.label), /Enable hermes-vitals-light/)
  plugin.dispose()
})

test('coming back into view polls at once and keeps the figures', async () => {
  let calls = 0
  const plugin = load(async () => {
    calls++

    return calls === 1 ? STATS : { ...STATS, cpu_percent: 90 }
  })

  await plugin.fire()
  setHidden(true)
  await plugin.fire()
  assert.equal(calls, 1, 'no request while the window is hidden')

  setHidden(false)
  fireVisibility()
  await plugin.fire()

  const chip = plugin.chip()
  assert.equal(calls, 2)
  assert.match(text(chip.props.children), /CPU 90%/)
  assert.equal(chip.props.children.props.children[1].props.style, undefined)
  plugin.dispose()
})

test('the backoff reaches 30 s and a success restores the normal cadence', async () => {
  let down = true
  const plugin = load(async () => {
    if (down) {
      throw new Error('Timed out connecting to Hermes backend after 8000ms')
    }

    return STATS
  })

  for (let i = 0; i < 4; i++) {
    await plugin.fire()
  }

  assert.equal(plugin.timers.filter(t => t.live).at(-1).ms, 30_000)

  down = false
  await plugin.fire()

  const chip = plugin.chip()
  assert.equal(plugin.timers.filter(t => t.live).at(-1).ms, 3000)
  assert.equal(chip.props.children.props.children[1].props.style, undefined)
  assert.match(text(chip.props.children), /CPU 23%/)
  plugin.dispose()
})

test('switching server drops the old reply and polls the new one', async () => {
  let release
  const plugin = load(() => new Promise(resolve => (release = resolve)))

  const pending = plugin.fire()
  connectionId.set('remote-ssh')
  release(STATS)
  await pending

  assert.equal(plugin.chip(), null, 'reply from the previous server must not paint')
  assert.equal(plugin.timers.filter(t => t.live).at(-1).ms, 0, 'new server is polled at once')
  plugin.dispose()
})
