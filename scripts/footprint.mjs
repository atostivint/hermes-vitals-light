#!/usr/bin/env node
// Measured footprint of this plugin's halves on THIS machine, printed as a markdown table:
//   npm run footprint
//
// Rows: bare interpreter, interpreter + psutil, the real TUI feed child (spawned through
// `startFeed` from the generated tui half, so the code measured is the code shipped), that child
// with both counts switched off, a second child that reports its own RSS from the inside (the
// cross-check), and `dashboard/plugin_api.py` loaded on top of psutil.
//
// RSS is the OS working set. Node cannot read another process's memory, so ONE long-lived python
// sampler is fed the feed child's pid once and prints one line per 500 ms
// (`{"t":…,"pid":…,"ws":…,"private":…,"cpu":…}`, ws = working set). A venv `python.exe` on Windows
// is often a trampoline: the pid `spawn` returns is a ~6 MB launcher whose python child does the
// work. The sampler walks the tree and measures the python descendant (largest working set), and
// each row names the pid it actually measured — sampling the launcher alone is what used to print
// a fake 6.4 MB. Short-lived rows measure themselves on the way out. Windows uses
// GetProcessMemoryInfo, Linux /proc/<pid>/status; macOS reports `unavailable` rather than guessing.
// Node builtins only, no npm dependency.
import { spawn } from 'node:child_process'
import { platform, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFeed } from '../tui/hermes-vitals-light.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PY = process.env.HERMES_PYTHON?.trim() || process.env.PYTHON?.trim() || (platform() === 'win32' ? 'python' : 'python3')
const GLOBAL_PY = platform() === 'win32' ? 'python' : 'python3'
const MB = 1024 * 1024
const WIN32 = platform() === 'win32'
const UNSUPPORTED = platform() === 'darwin' // no sampler: rows say so instead of guessing
const FEED_MS = 12_000 // one tick per second, so at least one process scan is paid for
const SAMPLE_MS = FEED_MS + 2500 // the sampler outlives the child so the last figure is never truncated
const SELF_FROM_MS = 4_000 // the self-report starts once the child is out of interpreter warm-up

// GetProcessMemoryInfo/GetProcessTimes over an open handle; shared by the sampler and the
// self-measuring rows.
const WIN_PROBE = `
import ctypes as c, ctypes.wintypes as w, json, os, sys, time
class PM(c.Structure):  # PROCESS_MEMORY_COUNTERS_EX
    _fields_ = [("cb", w.DWORD), ("faults", w.DWORD), ("peak_ws", c.c_size_t), ("ws", c.c_size_t),
                ("a", c.c_size_t), ("b", c.c_size_t), ("c1", c.c_size_t), ("d", c.c_size_t),
                ("e", c.c_size_t), ("f", c.c_size_t), ("private", c.c_size_t)]
k = c.windll.kernel32
k.OpenProcess.restype = w.HANDLE
k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
def pmem(h):
    pm = PM(); pm.cb = c.sizeof(PM)
    c.windll.psapi.GetProcessMemoryInfo(h, c.byref(pm), c.sizeof(PM))
    return {"ws": pm.ws, "peak": pm.peak_ws, "private": pm.private}
def cpu(h):
    kern, user = c.c_ulonglong(), c.c_ulonglong()
    k.GetProcessTimes(h, c.byref(c.c_ulonglong()), c.byref(c.c_ulonglong()), c.byref(kern), c.byref(user))
    return round((kern.value + user.value) / 1e7, 2)
`

// Windows: one sample of `pid`, plus the process table so the caller can walk the tree.
const WIN_TARGET = `${WIN_PROBE}
class PE(c.Structure):  # PROCESSENTRY32
    _fields_ = [("cb", w.DWORD), ("usage", w.DWORD), ("pid", w.DWORD), ("heap", c.c_void_p),
                ("module", w.DWORD), ("threads", w.DWORD), ("ppid", w.DWORD), ("pri", c.c_long),
                ("flags", w.DWORD), ("exe", c.c_char * 260)]
k.CreateToolhelp32Snapshot.restype = c.c_void_p
k.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
k.Process32First.argtypes = [w.HANDLE, c.POINTER(PE)]
k.Process32Next.argtypes = [w.HANDLE, c.POINTER(PE)]
def procs():
    snap = k.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap == c.c_void_p(-1).value:
        return []
    one = PE(); one.cb = c.sizeof(PE); out = []
    ok = k.Process32First(snap, one)
    while ok:
        out.append((one.pid, one.ppid, one.exe.decode("mbcs", "replace").lower()))
        ok = k.Process32Next(snap, one)
    k.CloseHandle(snap)
    return out
def sample(pid):
    h = k.OpenProcess(0x0410, False, pid)
    if not h:
        return None
    one = pmem(h); one["cpu"] = cpu(h); one["pid"] = pid
    k.CloseHandle(h)
    return one
`

// Linux: /proc/<pid>/status for the figures, /proc/<pid>/stat for utime+stime and ppid.
const LINUX_TARGET = `
import json, os, re, sys, time
def one(pid):
    try:
        status = open("/proc/%s/status" % pid).read()
        stat = open("/proc/%s/stat" % pid).read()
    except OSError:
        return None
    kb = lambda k: int(re.search("^" + k + ":\\\\s+(\\\\d+) kB", status, re.M).group(1)) * 1024
    fields = stat.rsplit(") ", 1)[1].split()  # field 14/15 of /proc/pid/stat: utime, stime
    return {"pid": pid, "ws": kb("VmRSS"), "peak": kb("VmHWM"), "private": kb("RssAnon"),
            "cpu": round((int(fields[11]) + int(fields[12])) / 100, 2), "ppid": int(fields[1])}
def procs():
    out = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        got = one(int(name))
        if got is not None:
            got["name"] = open("/proc/%s/comm" % name).read().strip().lower()
            out.append(got)
    return [(p["pid"], p["ppid"], p["name"]) for p in out]
def sample(pid):
    got = one(pid)
    if got is not None:
        got.pop("ppid", None)
    return got
`

// Both platforms: resolve the pid that actually does the work, then print one line per 500 ms.
const SAMPLER_BODY = `
def descendants(root):
    kids = {}
    for pid, ppid, name in procs():
        kids.setdefault(ppid, []).append((pid, name))
    seen, todo = [], [root]
    while todo:
        for child in kids.get(todo.pop(), []):
            seen.append(child)
            todo.append(child[0])
    return seen
def measure(root):
    workers = [(pid, name) for pid, name in descendants(root) if "python" in name]
    best = None
    for pid, _ in workers or [(root, "")]:
        got = sample(pid)
        if got is not None and (best is None or got["ws"] > best["ws"]):
            best = got
    if best is None:
        return None
    best["root"] = root
    best["shim"] = bool(workers)  # the pid spawn() returned has python children: it is a launcher
    best["n"] = len(workers)
    return best
root, start = int(sys.argv[1]), time.perf_counter()
while time.perf_counter() - start < int(sys.argv[2]) / 1000:
    got = measure(root)
    t = round((time.perf_counter() - start) * 1000)
    if got is None:
        print(json.dumps({"gone": True, "t": t}), flush=True)
        break
    print(json.dumps(dict(got, t=t)), flush=True)
    time.sleep(0.5)
`

const SAMPLER = `${WIN32 ? WIN_TARGET : LINUX_TARGET}${SAMPLER_BODY}`

// Reads the calling process's own counters. Used by the short-lived rows, which measure
// themselves on the way out, and by the self-report thread injected into the cross-check child.
const PROBE_SELF = WIN32
  ? `${WIN_PROBE}
def mem():
    h = k.OpenProcess(0x0410, False, os.getpid())
    got = pmem(h); got["cpu"] = cpu(h)
    k.CloseHandle(h)
    return got
`
  : `
import json, re
def mem():
    status, stat = open("/proc/self/status").read(), open("/proc/self/stat").read()
    kb = lambda k: int(re.search("^" + k + ":\\\\s+(\\\\d+) kB", status, re.M).group(1)) * 1024
    fields = stat.rsplit(") ", 1)[1].split()
    return {"ws": kb("VmRSS"), "peak": kb("VmHWM"), "private": kb("RssAnon"),
            "cpu": round((int(fields[11]) + int(fields[12])) / 100, 2)}
`

// Prefixed to the shipped child code: the child still runs the exact `STATS_PY` body (wrapped in
// `compile`, because that body opens with a `__future__` import and so cannot simply be prefixed),
// it just also prints its own working set to stdout (VITALS_* is untouched) so the external
// sampler can be checked against an independent measurement inside the same process.
const SELF_PROBE = `${PROBE_SELF}
import threading as _th, time as _t, sys as _sys, json as _json
def _self_reports():
    _t.sleep(${SELF_FROM_MS / 1000})
    while True:
        try:
            _sys.stdout.write(_json.dumps({"self_report": mem()}) + "\\n")
            _sys.stdout.flush()
        except Exception:
            return
        _t.sleep(0.5)
_th.Thread(target=_self_reports, daemon=True).start()
`

const probedArgs = args => ['-c', `${SELF_PROBE}exec(compile(${JSON.stringify(args[1])}, "<feed>", "exec"), globals())`]

const mb = bytes => (bytes === null || bytes === undefined ? '-' : `${(bytes / MB).toFixed(1)} MB`)

function median(values) {
  const sorted = values.filter(v => typeof v === 'number').sort((a, b) => a - b)

  if (!sorted.length) return null

  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function run(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''

    child.stdout.setEncoding('utf8').on('data', chunk => (out += chunk))
    child.stderr.setEncoding('utf8').on('data', chunk => (err += chunk))
    child.on('error', exc => resolve({ code: -1, out, err: exc.message }))
    child.on('close', code => resolve({ code, out, err }))
  })
}

// One sampler process for the whole row: it is fed the pid once and streams one JSON line per
// 500 ms, resolving a launcher pid to the python child that does the work.
async function sampleChild(pid, ms) {
  if (UNSUPPORTED) return { error: 'no sampler on darwin' }

  const { out, err } = await run(PY, ['-c', SAMPLER, String(pid), String(ms)])
  const lines = out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const failure = lines.find(line => line.error || line.gone)

  if (failure?.error) return { error: failure.error }

  const samples = lines.filter(line => typeof line.ws === 'number')

  if (!samples.length) {
    return { error: (err.trim().split('\n').pop() || (failure ? 'the child was gone before the first sample' : 'sampler printed no JSON')).slice(0, 100) }
  }

  return { samples }
}

// A short-lived interpreter row: the python one-liner reports its own figures on the way out.
async function selfRow(what, body, exe = PY) {
  const row = { what, median: null, peak: null, cpu: null, note: '' }

  if (UNSUPPORTED) return { ...row, note: 'unavailable: no sampler on darwin' }

  const { code, out, err } = await run(exe, ['-c', `${PROBE_SELF}\n${body}`])

  if (code !== 0) {
    return { ...row, note: `unavailable: ${(err.trim().split('\n').pop() || `exit ${code}`).slice(0, 100)}` }
  }

  const figures = JSON.parse(out.trim().split('\n').pop())

  return {
    ...row,
    median: figures.ws,
    peak: figures.peak,
    cpu: figures.cpu ?? null,
    figures,
    note: `private ${mb(figures.private)}`
  }
}

// The shipped feed child, spawned through `startFeed` with a wrapper that records the pid.
// `probe` prepends SELF_PROBE so the same child also reports its own RSS (`selfReports`).
async function feedRow(what, skip, probe = false) {
  let child
  let lines = 0
  let firstMs = 0
  const selfReports = []
  const started = Date.now()
  const stop = startFeed(
    body => {
      if (body === null) return
      if (body.self_report) {
        selfReports.push(body.self_report)
        return
      }
      if (!lines) firstMs = Date.now() - started
      lines += 1
    },
    (py, args, opts) => (child = spawn(py, probe ? probedArgs(args) : args, opts)),
    skip,
    1
  )

  if (!child?.pid) {
    stop()

    return { what, median: null, peak: null, cpu: null, note: 'unavailable: python did not start' }
  }

  const sampling = sampleChild(child.pid, SAMPLE_MS)

  await new Promise(resolve => setTimeout(resolve, FEED_MS))
  stop()

  const { samples = [], error } = await sampling

  if (error || !samples.length) {
    return { what, median: null, peak: null, cpu: null, note: `unavailable: ${error || 'no sample taken'}` }
  }

  const last = samples.at(-1)
  const pids = [...new Set(samples.map(one => one.pid))]
  const measured = last.shim
    ? `measured pid ${pids.join('+')} (spawned pid ${last.root} is a launcher, ${last.n} python descendant(s))`
    : `measured pid ${pids.join('+')} (spawned directly, no launcher)`
  const note = `${lines} JSON lines, first line ${firstMs} ms, ${measured}, private ${mb(median(samples.map(one => one.private)))}, ${samples.length} samples, VITALS_SKIP=${skip || 'empty'}`

  return {
    what,
    median: median(samples.map(one => one.ws)),
    peak: Math.max(...samples.map(one => one.peak)),
    cpu: last.cpu,
    note,
    samples,
    selfReports
  }
}

async function main() {
  const py = await run(PY, ['-c', 'import sys;print(sys.executable);print(sys.version.split()[0])'])
  const psutil = await run(PY, ['-c', 'import psutil;print(psutil.__version__)'])
  const [exe, version] = py.code === 0 ? py.out.trim().split('\n') : ['unavailable', '-']
  const pluginApi = join(ROOT, 'dashboard', 'plugin_api.py').replace(/\\/g, '/')
  const backend = await selfRow(
    '`import psutil` + `dashboard/plugin_api.py`',
    `import importlib.util as u, json, time
t0 = time.perf_counter()
import psutil
t1 = time.perf_counter()
spec = u.spec_from_file_location("plugin_api", r"${pluginApi}")
spec.loader.exec_module(u.module_from_spec(spec))
t2 = time.perf_counter()
after = mem()
print(json.dumps({"ws": after["ws"], "peak": after["peak"], "private": after["private"],
                  "psutil_ms": round((t1 - t0) * 1000, 1), "module_ms": round((t2 - t1) * 1000, 1)}))`
  )
  const baseline = await selfRow('bare interpreter: `python -c pass` plus the measuring shim', 'print(json.dumps(mem()))')
  const psutilRow = await selfRow('interpreter + `import psutil`', 'import psutil\nprint(json.dumps(mem()))')
  const globalRow =
    GLOBAL_PY === PY ? null : await selfRow('bare interpreter, global `python` (self-measured)', 'print(json.dumps(mem()))', GLOBAL_PY)

  if (baseline.median !== null && psutilRow.median !== null) {
    psutilRow.note = `+${mb(psutilRow.median - baseline.median)} over baseline, private ${mb(psutilRow.figures.private)}`
  }

  if (backend.median !== null && psutilRow.median !== null) {
    const extra = backend.median - psutilRow.median

    backend.note = `module alone: +${mb(extra)} over psutil, load ${backend.figures.module_ms} ms`
  }

  const feed = await feedRow('TUI feed child, all figures', '')
  const feedSkipped = await feedRow('TUI feed child, both counts off', 'clients,processes')
  const check = await feedRow('TUI feed child, self-report cross-check', '', true)
  const rows = [baseline, psutilRow, globalRow, feed, feedSkipped, backend].filter(Boolean)
  const psutilVersion = psutil.code === 0 ? psutil.out.trim() : 'unavailable'

  console.log('## Footprint, measured on this machine\n')
  console.log(`python \`${exe}\` ${version} | psutil ${psutilVersion} | node ${process.version} | ${platform()} ${release()} | ${(totalmem() / MB / 1024).toFixed(1)} GiB RAM`)
  console.log(
    `TUI feed child runs on \`${exe}\`${process.env.HERMES_PYTHON?.trim() ? ' (from HERMES_PYTHON)' : ' (platform default; set HERMES_PYTHON to the interpreter Hermes uses)'}`
  )
  console.log(`RSS is the OS working set (${WIN32 ? 'GetProcessMemoryInfo' : 'VmRSS'}); the feed child is sampled every 500 ms by one long-lived python process.`)
  console.log('The TUI child runs 12 s at a 1 s cadence (VITALS_INTERVAL=1). Short-lived rows measure themselves, so their RSS includes the measuring shim; the shim cancels in the deltas.\n')
  console.log('| what | median RSS | peak RSS | CPU time | notes |')
  console.log('| --- | --- | --- | --- | --- |')

  for (const row of rows) {
    console.log(`| ${row.what} | ${mb(row.median)} | ${mb(row.peak)} | ${row.cpu === null ? '-' : `${row.cpu} s`} | ${row.note} |`)
  }

  if (check.median !== null && check.selfReports.length) {
    const own = median(check.selfReports.map(one => one.ws))
    const ownPeak = Math.max(...check.selfReports.map(one => one.peak))
    const gap = check.median - own
    const verdict = Math.abs(gap) <= 3 * MB ? 'agree' : 'DISAGREE — the external number is not trustworthy'

    console.log(
      `\nCross-check, same child, same run: external sampler ${mb(check.median)} (median of ${check.samples.length} samples) vs the child's own ${mb(own)} (median of ${check.selfReports.length} self-reports, peak ${mb(ownPeak)}), gap ${mb(Math.abs(gap))} — ${verdict}.`
    )
  } else {
    console.log(`\nCross-check: unavailable (${check.note || 'the self-report never reached the parent'}).`)
  }

  console.log('\nTwo runs on one machine differ by about 1 MB; a figure that moves more is a real difference.')
}

await main()
