/**
 * hermes-vitals-light for the Hermes TUI (`hermes --tui`) — the Desktop chip as an
 * ambient card docked above the status bar: "CPU 23% · Load 1.20 · 3.8G free
 * · waited 15s/60 · ⚙ 3", coloured by the PSI waited verdict. No session count
 * here: it comes from the server's /api/status, and the TUI measures its own machine.
 *
 * The TUI runs on the machine it measures, so there is no route to poll: the
 * card runs dashboard/plugin_api.py (inlined below) with the TUI's own Hermes
 * python, which prints the /stats body every 3 s. The child lives as long as
 * the card is docked.
 *
 *   /vitals                 dock / undock the card
 *   /vitals ram off         hide a figure (cpu, load, ram, waited, processes)
 *   /vitals detail on       add the tooltip lines under the chip line
 *   /vitals every 10        refresh every 10 s (1, 3, 5, 10, 30 or 60; default 3)
 *   /vitals all on | reset  every figure / back to the defaults
 *   /vitals help            usage and the current options
 *
 * Options persist in <HERMES_HOME>/vitals.json, shared by every TUI of
 * that home.
 *
 * Edit this file, then `node scripts/build.mjs`: load.js, options.js and
 * plugin_api.py are inlined to give the single tui/hermes-vitals-light.mjs the TUI
 * loads from <HERMES_HOME>/tui-widgets/.
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// dashboard/plugin_api.py, inlined by scripts/build.mjs.
const STATS_PY = "\"\"\"hermes-vitals-light backend, mounted at ``/api/plugins/hermes-vitals-light/``.\r\n\r\nOne read-only route, ``GET /stats``: CPU and memory of the machine running the Hermes backend the\r\nDesktop is connected to (``hermes serve`` runs this file in-process, so a remote gateway reports\r\nthe remote box, not the Desktop's), plus how many sessions are active right now.\r\n\r\n``waited`` is Linux PSI CPU pressure: the ``some avg60`` field of ``/proc/pressure/cpu`` scaled\r\nto the seconds of the last minute at least one task was runnable but stalled waiting for a CPU\r\n(``round(avg60 * 0.6)``). ``free`` is ``MemAvailable`` from ``/proc/meminfo``. Both come from one\r\nstateless two-file read with no psutil, subprocess or cache; either is omitted when its file is\r\nunreadable. The verdict is ``stuck`` at 25 waited seconds or less than 1 GiB free, ``busy`` at\r\n10 waited seconds, and ``ok`` otherwise.\r\n\r\nThe session count is Hermes's own ``active_sessions`` figure from its public ``GET /api/status``\r\n(sessions not ended and active in the last 5 minutes, among the 50 most recent, current profile).\r\nThe route asks the server it runs in over loopback, on the socket address the request arrived\r\non (not its ``Host`` header: behind an SSH tunnel that is the tunnel's port). ``/api/status`` does\r\nmuch more than count, so the answer is cached for 15 s, failures included, and refreshed in the\r\nbackground: the route never waits for it. It needs the route to run inside the server\r\n(``plugins.isolation: in_process``, the default); in the plugin host there is no address to ask,\r\nand the count is left out. It is a total: no per-client breakdown.\r\n\r\nThe process count is every Hermes executable running on the box, any profile: ``hermes``\r\n(per subcommand: ``serve``, ``chat``, ``gateway``…), ``hermes-agent``, ``hermes-acp``, or a\r\npython running one of them. A Hermes started by another Hermes (the Windows launcher's python\r\nchild, the TUI's ``tui_gateway``, an agent running ``hermes`` from its terminal) counts under\r\nits top-level ancestor. The Electron Desktop (``Hermes``, capitalised) is not counted. The scan\r\nis cached for 5 s and refreshed in the background, so it never blocks a request either: the first\r\nanswer after a start can omit the count.\r\n\r\n``?skip=clients,processes`` leaves those counts out and does not measure them: the chip asks\r\nfor it when they are switched off in its settings (the TUI passes ``VITALS_SKIP``).\r\n\r\nOnly load figures, the hostname, the waited/free figures and the session / per-command counts\r\nleave this process: no session ids, process list, paths or env. Fail-open by contract: without\r\npsutil the route answers ``{\"ok\": false}``, an unreadable load figure is omitted and the others\r\nstill answer, and an unreachable ``/api/status``, unreadable process table or unreadable\r\n``/proc`` file just omits that field.\r\n\r\nThe dashboard loader imports this file as a top-level module, so it stays self-contained. The TUI\r\nwidget (``src/tui.src.mjs``) inlines it too and runs it as ``python -c``: ``stream()`` prints the\r\nsame body as a JSON line every 3 s.\r\n\"\"\"\r\n\r\nfrom __future__ import annotations\r\n\r\nimport json\r\nimport logging\r\nimport math\r\nimport os\r\nimport platform\r\nimport re\r\nimport threading\r\nimport time\r\nimport urllib.request\r\nfrom collections import Counter\r\nfrom typing import Any, Iterable\r\n\r\nlogger = logging.getLogger(__name__)\r\n\r\ntry:  # FastAPI exists in the serve/dashboard env, not in the plugin's unit-test env.\r\n    from fastapi import APIRouter, Request, Response\r\n\r\n    router = APIRouter()\r\nexcept ImportError:  # pragma: no cover - unit env without FastAPI\r\n    router = None\r\n\r\ntry:\r\n    import psutil\r\nexcept ImportError:  # pragma: no cover - psutil is a Hermes core dependency\r\n    psutil = None\r\nelse:\r\n    try:\r\n        # cpu_percent(interval=None) measures since the previous call; prime it so the first poll\r\n        # reports a real figure instead of 0.0, and the route never blocks a worker thread.\r\n        psutil.cpu_percent(interval=None)\r\n    except Exception:  # pragma: no cover - a broken primer must not stop the plugin loading\r\n        pass\r\n\r\n\r\ndef collect_stats(ps: Any = psutil) -> dict[str, Any]:\r\n    \"\"\"The load figures, each measured independently: one unreadable figure never hides the others.\"\"\"\r\n    if ps is None:\r\n        return {\"ok\": False}\r\n\r\n    stats: dict[str, Any] = {\"ok\": True}\r\n\r\n    try:\r\n        hostname = platform.node()\r\n    except Exception as exc:  # pragma: no cover - platform.node is effectively infallible\r\n        logger.debug(\"hermes-vitals-light: hostname unreadable: %s\", exc)\r\n    else:\r\n        if hostname:\r\n            stats[\"hostname\"] = hostname\r\n\r\n    cpu_count = os.cpu_count()\r\n    if cpu_count:\r\n        stats[\"cpu_count\"] = cpu_count\r\n\r\n    try:\r\n        stats[\"cpu_percent\"] = ps.cpu_percent(interval=None)\r\n    except Exception as exc:\r\n        logger.debug(\"hermes-vitals-light: cpu_percent unreadable: %s\", exc)\r\n\r\n    try:\r\n        vm = ps.virtual_memory()\r\n        stats[\"memory\"] = {\"total\": vm.total, \"used\": vm.total - vm.available, \"percent\": vm.percent}\r\n    except Exception as exc:\r\n        logger.debug(\"hermes-vitals-light: virtual_memory unreadable: %s\", exc)\r\n\r\n    getloadavg = getattr(ps, \"getloadavg\", None)\r\n    if getloadavg is not None:\r\n        try:\r\n            stats[\"load_avg\"] = [round(v, 2) for v in getloadavg()]\r\n        except Exception as exc:\r\n            logger.debug(\"hermes-vitals-light: load average unreadable: %s\", exc)\r\n\r\n    if \"cpu_percent\" not in stats and \"memory\" not in stats:\r\n        return {\"ok\": False}\r\n    return stats\r\n\r\n\r\nWAITED_STUCK_SECONDS = 25\r\nWAITED_BUSY_SECONDS = 10\r\nLOW_FREE_BYTES = 1024 * 1024**2\r\n\r\n\r\ndef parse_pressure(text: str) -> float | None:\r\n    \"\"\"The ``avg60`` value of the ``some`` line in ``/proc/pressure/cpu`` text.\"\"\"\r\n    for line in text.splitlines():\r\n        fields = line.split()\r\n        if not fields or fields[0] != \"some\":\r\n            continue\r\n        for field in fields[1:]:\r\n            if field.startswith(\"avg60=\"):\r\n                try:\r\n                    value = float(field.partition(\"=\")[2])\r\n                except ValueError:\r\n                    return None\r\n                return value if math.isfinite(value) else None\r\n    return None\r\n\r\n\r\ndef parse_meminfo(text: str) -> int | None:\r\n    \"\"\"``MemAvailable`` from ``/proc/meminfo`` text, in bytes (the file is in KiB).\"\"\"\r\n    for line in text.splitlines():\r\n        if line.startswith(\"MemAvailable:\"):\r\n            fields = line.split()\r\n            if len(fields) < 2:\r\n                return None\r\n            try:\r\n                return int(fields[1]) * 1024\r\n            except ValueError:\r\n                return None\r\n    return None\r\n\r\n\r\ndef waited_verdict(seconds: int, free: int | None) -> str:\r\n    \"\"\"``stuck`` / ``busy`` / ``ok`` from waited seconds and MemAvailable bytes.\"\"\"\r\n    if seconds >= WAITED_STUCK_SECONDS or (free is not None and free < LOW_FREE_BYTES):\r\n        return \"stuck\"\r\n    if seconds >= WAITED_BUSY_SECONDS:\r\n        return \"busy\"\r\n    return \"ok\"\r\n\r\n\r\ndef read_pressure() -> dict[str, Any]:\r\n    \"\"\"One stateless read of ``/proc/pressure/cpu`` and ``/proc/meminfo``; omit what is unreadable.\"\"\"\r\n    pressure_text = meminfo_text = None\r\n    try:\r\n        with open(\"/proc/pressure/cpu\", encoding=\"ascii\", errors=\"replace\") as pressure:\r\n            pressure_text = pressure.read()\r\n    except OSError:\r\n        pass\r\n    try:\r\n        with open(\"/proc/meminfo\", encoding=\"ascii\", errors=\"replace\") as meminfo:\r\n            meminfo_text = meminfo.read()\r\n    except OSError:\r\n        pass\r\n\r\n    avg60 = parse_pressure(pressure_text) if pressure_text is not None else None\r\n    free = parse_meminfo(meminfo_text) if meminfo_text is not None else None\r\n    result: dict[str, Any] = {}\r\n    if free is not None:\r\n        result[\"free\"] = free\r\n    if avg60 is not None:\r\n        seconds = round(avg60 * 0.6)\r\n        result[\"waited\"] = {\"seconds\": seconds, \"verdict\": waited_verdict(seconds, free)}\r\n    return result\r\n\r\n\r\n# ``/api/status`` also checks the config version, probes the gateway and lists the profiles and\r\n# components, so it is asked about every STATUS_TTL seconds, not at the chip's 3 s cadence.\r\nSTATUS_TTL = 15.0\r\n_STATUS_TIMEOUT = 2.0\r\n_no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback never goes through a proxy\r\n# url -> (asked at, total or None). A failed ask is cached too, so an unreachable\r\n# server is not hammered on every poll.\r\n_status_cache: dict[str, tuple[float, int | None]] = {}\r\n_status_lock = threading.Lock()\r\n_status_refreshing: set[str] = set()\r\n\r\n\r\ndef _start_thread(target: Any) -> None:\r\n    threading.Thread(target=target, name=\"hermes-vitals-light-refresh\", daemon=True).start()\r\n\r\n\r\ndef status_url(scope: dict[str, Any]) -> str | None:\r\n    \"\"\"``/api/status`` of the server a request reached, from the socket it arrived on.\r\n\r\n    Not the ``Host`` header: a client behind an SSH tunnel names the tunnel's local port.\r\n    \"\"\"\r\n    server = scope.get(\"server\")\r\n    if not server or not server[1]:  # a unix socket has no port\r\n        return None\r\n    host = server[0]\r\n    host = \"127.0.0.1\" if host in (\"0.0.0.0\", \"\") else \"[::1]\" if \":\" in host else host\r\n    scheme = \"https\" if scope.get(\"scheme\") in (\"https\", \"wss\") else \"http\"\r\n    return f\"{scheme}://{host}:{server[1]}/api/status\"\r\n\r\n\r\ndef active_sessions(url: str, clock: Any = time.monotonic) -> int | None:\r\n    \"\"\"Hermes's ``active_sessions`` from ``url``, or None when it cannot be read (cached, failures too).\"\"\"\r\n    with _status_lock:\r\n        cached = _status_cache.get(url)\r\n    if cached is not None and clock() - cached[0] < STATUS_TTL:\r\n        return cached[1]\r\n\r\n    total = None\r\n    try:\r\n        with _no_proxy.open(url, timeout=_STATUS_TIMEOUT) as response:\r\n            total = json.load(response).get(\"active_sessions\")\r\n    except Exception as exc:  # OSError, HTTPException, ValueError, AttributeError: not a JSON object…\r\n        logger.debug(\"hermes-vitals-light: /api/status unreadable: %s\", exc)\r\n    if isinstance(total, bool) or not isinstance(total, int):\r\n        total = None\r\n    with _status_lock:\r\n        _status_cache[url] = (clock(), total)\r\n    return total\r\n\r\n\r\ndef _refresh_status_async(url: str, clock: Any = time.monotonic, start: Any = _start_thread) -> None:\r\n    \"\"\"Refresh ``/api/status`` in the background, once per URL; a request never waits for it.\"\"\"\r\n    with _status_lock:\r\n        if url in _status_refreshing:\r\n            return\r\n        _status_refreshing.add(url)\r\n\r\n    def refresh() -> None:\r\n        try:\r\n            active_sessions(url, clock=clock)\r\n        finally:\r\n            with _status_lock:\r\n                _status_refreshing.discard(url)\r\n\r\n    try:\r\n        start(refresh)\r\n    except Exception as exc:  # thread creation failure must not fail the route\r\n        logger.debug(\"hermes-vitals-light: status refresh not started: %s\", exc)\r\n        with _status_lock:\r\n            _status_refreshing.discard(url)\r\n\r\n\r\ndef cached_active_sessions(url: str, clock: Any = time.monotonic, start: Any = _start_thread) -> int | None:\r\n    \"\"\"The cached session total, refreshed in the background; None on the first ask for a URL.\"\"\"\r\n    with _status_lock:\r\n        cached = _status_cache.get(url)\r\n\r\n    if cached is not None and clock() - cached[0] < STATUS_TTL:\r\n        return cached[1]\r\n\r\n    _refresh_status_async(url, clock=clock, start=start)\r\n    return cached[1] if cached is not None else None\r\n\r\n\r\n# Console scripts from Hermes' pyproject; None means \"read the subcommand from argv\".\r\n_CONSOLE_SCRIPTS = {\"hermes\": None, \"hermes-agent\": \"agent\", \"hermes-acp\": \"acp\"}\r\n_MODULES = {\"hermes_cli.main\": None, \"agent.legacy_cli\": \"agent\", \"acp_adapter.entry\": \"acp\", \"tui_gateway.entry\": \"tui\"}\r\n_PYTHON = re.compile(r\"^pythonw?(\\d+(\\.\\d+)?)?$\")\r\n\r\n\r\ndef _stem(path: str) -> str:\r\n    name = re.split(r\"[\\\\/]\", path)[-1]\r\n    return name[:-4] if name.lower().endswith(\".exe\") else name\r\n\r\n\r\ndef _subcommand(args: list[str]) -> str:\r\n    skip = False\r\n    for arg in args:\r\n        if skip:\r\n            skip = False\r\n        elif arg in (\"-p\", \"--profile\"):\r\n            skip = True\r\n        elif not arg.startswith(\"-\"):\r\n            return arg\r\n    return \"chat\"  # bare `hermes` opens a chat\r\n\r\n\r\ndef hermes_command(argv: list[str] | None) -> str | None:\r\n    \"\"\"The Hermes command a process runs (``serve``, ``chat``, ``acp``…), or None if it is not Hermes.\r\n\r\n    Case-sensitive on purpose: the console scripts are lowercase, the Electron Desktop is ``Hermes``.\r\n    \"\"\"\r\n    if not argv:\r\n        return None\r\n    rest = list(argv[1:])\r\n    stem = _stem(argv[0])\r\n    if _PYTHON.match(stem.lower()):\r\n        while rest and rest[0].startswith(\"-\") and rest[0] != \"-m\":\r\n            del rest[: 2 if rest[0] in (\"-X\", \"-W\") else 1]  # interpreter flags (-u, -X utf8…)\r\n        if len(rest) >= 2 and rest[0] == \"-m\" and rest[1] in _MODULES:\r\n            fixed, rest = _MODULES[rest[1]], rest[2:]\r\n        elif rest and _stem(rest[0]) in _CONSOLE_SCRIPTS:\r\n            fixed, rest = _CONSOLE_SCRIPTS[_stem(rest[0])], rest[1:]\r\n        else:\r\n            return None\r\n    elif stem in _CONSOLE_SCRIPTS:\r\n        fixed = _CONSOLE_SCRIPTS[stem]\r\n    else:\r\n        return None\r\n    return fixed or _subcommand(rest)\r\n\r\n\r\ndef count_hermes_processes(procs: Iterable[dict[str, Any]]) -> dict[str, Any]:\r\n    \"\"\"Count top-level Hermes processes per command from ``{\"pid\", \"ppid\", \"cmdline\"}`` rows.\"\"\"\r\n    parents: dict[int, int] = {}\r\n    commands: dict[int, str] = {}\r\n    for info in procs:\r\n        pid = info.get(\"pid\")\r\n        if pid is None:\r\n            continue\r\n        parents[pid] = info.get(\"ppid\") or 0\r\n        command = hermes_command(info.get(\"cmdline\"))\r\n        if command is not None:\r\n            commands[pid] = command\r\n\r\n    def under_another_hermes(pid: int) -> bool:\r\n        seen = {pid}\r\n        parent = parents.get(pid, 0)\r\n        while parent and parent not in seen:\r\n            if parent in commands:\r\n                return True\r\n            seen.add(parent)\r\n            parent = parents.get(parent, 0)\r\n        return False\r\n\r\n    by_command = Counter(cmd for pid, cmd in commands.items() if not under_another_hermes(pid))\r\n    return {\"total\": sum(by_command.values()), \"by_command\": dict(sorted(by_command.items()))}\r\n\r\n\r\n# The figures a client can switch off server-side: the load figures cost one psutil call, the\r\n# counts a ``/api/status`` call (every STATUS_TTL) and a full process scan (~50 ms of CPU per scan\r\n# on 500 processes).\r\nSKIPPABLE = (\"clients\", \"processes\")\r\n\r\n\r\ndef parse_skip(value: str | None) -> frozenset[str]:\r\n    \"\"\"``\"clients,processes\"`` -> the skippable names in it; unknown names are ignored.\"\"\"\r\n    return frozenset(name.strip() for name in (value or \"\").split(\",\")) & frozenset(SKIPPABLE)\r\n\r\n\r\n# The process scan is the expensive figure, and the first one can take seconds\r\n# on Windows. Keep the last answer; when it is stale, one background scan runs\r\n# and requests keep returning the previous count instead of waiting.\r\nPROCESS_TTL = 5.0\r\n_process_cache: tuple[float, dict[str, Any] | None] = (0.0, None)\r\n_process_lock = threading.Lock()\r\n\r\n\r\ndef _scan_hermes_processes() -> dict[str, Any] | None:\r\n    if psutil is None:\r\n        return None\r\n    try:\r\n        rows = (p.info for p in psutil.process_iter([\"pid\", \"ppid\", \"cmdline\"]))\r\n        return count_hermes_processes(rows)\r\n    except Exception as exc:  # psutil.Error, OSError: the chip just loses the count\r\n        logger.debug(\"hermes-vitals-light: process table unreadable: %s\", exc)\r\n        return None\r\n\r\n\r\ndef cached_process_count(now: Any = time.monotonic, start: Any = _start_thread) -> dict[str, Any] | None:\r\n    \"\"\"The last process count; a stale answer is returned while one background scan runs.\"\"\"\r\n    global _process_cache\r\n    asked, value = _process_cache\r\n    if now() - asked < PROCESS_TTL:\r\n        return value\r\n    if not _process_lock.acquire(blocking=False):\r\n        return value\r\n\r\n    def refresh() -> None:\r\n        global _process_cache\r\n        try:\r\n            _process_cache = (now(), _scan_hermes_processes())\r\n        finally:\r\n            _process_lock.release()\r\n\r\n    try:\r\n        start(refresh)\r\n    except Exception as exc:  # thread creation failure must not fail the route\r\n        logger.debug(\"hermes-vitals-light: process scan not started: %s\", exc)\r\n        _process_lock.release()\r\n        return value\r\n    return value\r\n\r\n\r\ndef snapshot(clients: bool = True, processes: bool = True, url: str | None = None) -> dict[str, Any]:\r\n    \"\"\"The ``/stats`` body: load figures, then the session and process counts asked for, when readable.\r\n\r\n    ``url`` is the server's ``/api/status``; without one (the TUI feed has no server) there is no session count.\r\n    The counts come from caches refreshed in the background, so this never waits for the process table or\r\n    ``/api/status``: the first answer after a start can simply omit them. ``waited`` and ``free`` come from\r\n    the two-file PSI/meminfo read and are likewise omitted when unreadable.\r\n    \"\"\"\r\n    try:\r\n        body = collect_stats()\r\n        if not body.get(\"ok\"):\r\n            return body\r\n        pressure = read_pressure()\r\n        if \"waited\" in pressure:\r\n            body[\"waited\"] = pressure[\"waited\"]\r\n        if \"free\" in pressure:\r\n            body[\"free\"] = pressure[\"free\"]\r\n        if clients and url:\r\n            total = cached_active_sessions(url)\r\n            if total is not None:\r\n                body[\"clients\"] = {\"total\": total}\r\n        if processes and psutil is not None:\r\n            counts = cached_process_count()\r\n            if counts is not None:\r\n                body[\"processes\"] = counts\r\n        return body\r\n    except Exception as exc:  # fail-open by contract, including unexpected psutil or cache errors\r\n        logger.debug(\"hermes-vitals-light: stats unavailable: %s\", exc)\r\n        return {\"ok\": False}\r\n\r\n\r\ndef stream(interval: float = 3.0, out: Any = None, skip: frozenset[str] = frozenset()) -> None:\r\n    \"\"\"One ``snapshot()`` JSON line per ``interval``: the TUI widget's feed (``python -c`` on this file).\r\n\r\n    The first line leaves out the process count, then the scan runs in the background: on Windows\r\n    the first full scan takes seconds (~13 s for 750 processes), later ones a tenth of a second.\r\n    The load figures never wait for it. ``skip`` drops counts for good (the figures the card\r\n    hides). Ends when the reader goes away: a closed pipe, or a parent that died without closing it.\r\n    \"\"\"\r\n    import json\r\n    import sys\r\n    import time\r\n\r\n    out = out or sys.stdout\r\n    parent = os.getppid()\r\n    time.sleep(min(interval, 0.5))  # give the first cpu_percent (primed at import) a real window\r\n    first = True\r\n    while True:\r\n        try:\r\n            body = snapshot(clients=\"clients\" not in skip, processes=not first and \"processes\" not in skip)\r\n            out.write(json.dumps(body) + \"\\n\")\r\n            out.flush()\r\n        except (BrokenPipeError, OSError, ValueError):  # ValueError: write to a closed file\r\n            return\r\n        first = False\r\n        time.sleep(interval)\r\n        if os.getppid() != parent:\r\n            return\r\n\r\n\r\nif router is not None:\r\n\r\n    # ``?skip=clients,processes``: the counts the chip hides are not measured at all.\r\n    @router.get(\"/stats\")\r\n    def stats(request: Request, response: Response, skip: str = \"\") -> dict[str, Any]:\r\n        response.headers[\"Cache-Control\"] = \"no-store\"\r\n        skipped = parse_skip(skip)\r\n        return snapshot(\r\n            clients=\"clients\" not in skipped,\r\n            processes=\"processes\" not in skipped,\r\n            url=status_url(request.scope),\r\n        )\r\n\r\n\r\nif __name__ == \"__main__\":\r\n    stream(float(os.environ.get(\"VITALS_INTERVAL\", \"3\")), skip=parse_skip(os.environ.get(\"VITALS_SKIP\")))\r\n"

const optionsFile = () => join(process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes'), 'vitals.json')

function loadOptions() {
  try {
    return tuiOptions(JSON.parse(readFileSync(optionsFile(), 'utf8')))
  } catch {
    return tuiOptions()
  }
}

function saveOptions(options) {
  try {
    writeFileSync(optionsFile(), `${JSON.stringify(options, null, 2)}\n`)
  } catch {
    // Unwritable home: the change holds for this card only.
  }
}

/**
 * Starts the stats child; `onStats(body)` per line, `onStats(null)` once it is gone. Returns the stop.
 * `skip`: the counts the child does not measure (`"clients,processes"`).
 */
export function startFeed(onStats, spawnFn = spawn, skip = '', interval = DEFAULT_INTERVAL) {
  // The interpreter the TUI's own gateway runs on (set by the hermes launcher).
  const python = process.env.HERMES_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
  const env = { ...process.env, PYTHONUNBUFFERED: '1', VITALS_INTERVAL: String(interval), VITALS_SKIP: skip }

  const child = spawnFn(python, ['-c', STATS_PY], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let buffer = ''
  let gone = false

  const end = () => {
    if (!gone) {
      gone = true
      onStats(null)
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    const lines = (buffer + chunk).split('\n')

    buffer = lines.pop()

    for (const line of lines) {
      try {
        onStats(JSON.parse(line))
      } catch {
        // Not a stats line (a stray print): skip it.
      }
    }
  })
  child.on('error', end) // python not found
  child.on('exit', end)

  return () => {
    gone = true
    child.kill()
  }
}

// Widest each figure gets ("CPU 100%", "Load 12.34"…), so the card never resizes while ticking.
const FIGURE_WIDTH = { clients: 5, cpu: 8, load: 10, processes: 5, ram: 8, waited: 13 }

export function cardWidth(options) {
  const figures = CHIP_FIGURES.filter(({ id }) => options[id]).map(({ id }) => FIGURE_WIDTH[id])
  const line = figures.reduce((sum, width) => sum + width, 0) + 3 * Math.max(figures.length - 1, 0)

  // + border and padding; the detail lines need room for "Hermes running: chat 3 · serve 1".
  return Math.max(line + 4, options.detail ? 46 : 24)
}

// A function: the inlined modules (OPTIONS) are declared after this file's body.
export const usage = () => `usage: /vitals [${OPTIONS.join('|')}|all [on|off]] [every ${INTERVALS.join('|')}] [reset]`

export default function register(sdk) {
  const { Box, React, Text, defineWidgetApp, h } = sdk

  function Card({ options, t }) {
    const [feed, setFeed] = React.useState({ status: 'loading' })
    const skip = skippedFigures(options).join(',')

    // A new child when a count is switched on or off (a hidden one is never measured) or the period changes.
    React.useEffect(
      () =>
        startFeed(
          body => setFeed(body?.ok ? { stats: body, status: 'ok' } : { status: 'unavailable' }),
          spawn,
          skip,
          options.interval
        ),
      [skip, options.interval]
    )

    const lines = []

    if (feed.status === 'loading') {
      lines.push(h(Text, { color: t.color.muted, key: 'chip' }, 'vitals…'))
    } else if (feed.status === 'unavailable') {
      lines.push(
        h(Text, { color: t.color.error, key: 'chip', wrap: 'truncate-end' }, 'vitals unavailable (python/psutil)')
      )
    } else {
      const { stats } = feed
      const level = waitedVerdict(stats)
      const color = { busy: t.color.warn, ok: t.color.text, stuck: t.color.error }[level]

      // Every figure off still names the box, so the card is never empty.
      lines.push(h(Text, { color, key: 'chip', wrap: 'truncate-end' }, chipLabel(stats, options) || stats.hostname))

      if (options.detail) {
        for (const line of tooltipLines(stats)) {
          lines.push(h(Text, { color: t.color.muted, key: line, wrap: 'truncate-end' }, line))
        }
      }
    }

    return h(
      Box,
      { borderColor: t.color.border, borderStyle: 'round', flexDirection: 'column', paddingX: 1, width: cardWidth(options) },
      ...lines
    )
  }

  defineWidgetApp({
    id: 'hermes-vitals-light',
    help: 'CPU, load, RAM and Hermes processes of this machine (args: options)',
    mode: 'ambient',
    // A getter: the TUI prints `usage` when init refuses, which makes `/vitals help`
    // (or a typo) show the options as they are now.
    get usage() {
      return `${usage()}\nnow: ${describeOptions(loadOptions())}`
    },

    init(arg) {
      const current = loadOptions()

      if (!arg.trim()) {
        return { options: current }
      }

      const options = applyOptions(arg, current)

      if (options) {
        saveOptions(options)
      }

      return options && { options }
    },

    // Ambient: never receives keys; contract-complete for modal reuse.
    reduce: (state, { ch, key }) => (key.escape || ch === 'q' ? null : state),

    render: ({ state, t }) => h(Card, { options: state.options, t })
  })
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

// MemAvailable in GiB, exactly as the chip shows it: "3.8G free".
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
  { description: 'Free memory (Linux MemAvailable).', id: 'ram', label: 'RAM' },
  {
    description: 'Seconds in the last minute at least one task waited for CPU (Linux PSI).',
    id: 'waited',
    label: 'Waited on CPU'
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

// ── inlined from src/options.js ──
// The TUI widget's options and its `/vitals <option> [on|off]` syntax.
// Pure, like load.js: the tests import it directly.


// The chip figures the TUI card can show.
const TUI_FIGURES = CHIP_FIGURES.filter(({ tui }) => tui !== false).map(({ id }) => id)

// Those plus `detail` (the Desktop tooltip lines under the chip line, off by default).
const OPTIONS = [...TUI_FIGURES, 'detail']

// `interval`: the refresh period in seconds (`/vitals every 10`), not a switch.
const TUI_DEFAULTS = {
  ...Object.fromEntries(TUI_FIGURES.map(id => [id, true])),
  detail: false,
  interval: DEFAULT_INTERVAL
}

// Saved options over the defaults, so an option added later starts at its default.
function tuiOptions(saved) {
  const options = { ...TUI_DEFAULTS, interval: refreshInterval(saved?.interval) }

  for (const id of OPTIONS) {
    if (typeof saved?.[id] === 'boolean') {
      options[id] = saved[id]
    }
  }

  return options
}

const SWITCH = { off: false, on: true }

/**
 * Applies `cpu off`, `ram`, `all on`, `reset`, `cpu off ram off`… to `current`.
 * `all` covers the chip figures, not `detail`.
 * Returns the new options, or null when a word is not an option.
 */
function applyOptions(arg, current) {
  const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const next = { ...current }

  for (let i = 0; i < words.length; i++) {
    const word = words[i]

    if (word === 'reset') {
      Object.assign(next, TUI_DEFAULTS)
      continue
    }

    if (word === 'every') {
      // `every 10` or `every 10s`; only the offered periods.
      const seconds = Number.parseInt(words[i + 1], 10)

      if (!INTERVALS.includes(seconds)) {
        return null
      }

      next.interval = seconds
      i++
      continue
    }

    const ids = word === 'all' ? TUI_FIGURES : OPTIONS.includes(word) ? [word] : null

    if (!ids) {
      return null
    }

    const value = SWITCH[words[i + 1]]

    if (value !== undefined) {
      i++
    }

    // Without on/off: flip, and `all` turns everything on unless it already is.
    const on = value ?? !ids.every(id => next[id])

    for (const id of ids) {
      next[id] = on
    }
  }

  return next
}

function describeOptions(options) {
  return [...OPTIONS.map(id => `${id} ${options[id] ? 'on' : 'off'}`), `every ${options.interval}s`].join(' · ')
}
