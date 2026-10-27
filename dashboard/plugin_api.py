"""hermes-vitals-light backend, mounted at ``/api/plugins/hermes-vitals-light/``.

One read-only route, ``GET /stats``: CPU and memory of the machine running the Hermes backend the
Desktop is connected to (``hermes serve`` runs this file in-process, so a remote gateway reports
the remote box, not the Desktop's), plus how many sessions each client holds right now.

``waited`` is Linux PSI CPU pressure: the ``some avg60`` field of ``/proc/pressure/cpu`` scaled
to the seconds of the last minute at least one task was runnable but stalled waiting for a CPU
(``round(avg60 * 0.6)``). ``free`` is ``MemAvailable`` from ``/proc/meminfo``. Both come from one
stateless two-file read with no psutil, subprocess or cache; either is omitted when its file is
unreadable. The verdict is ``stuck`` at 25 waited seconds or less than 1 GiB free, ``busy`` at
10 waited seconds, and ``ok`` otherwise.

The session count is Hermes's own ``active_sessions`` figure from its public ``GET /api/status``
(sessions not ended and active in the last 5 minutes, among the 50 most recent, current profile).
The route asks the server it runs in over loopback, on the socket address the request arrived
on (not its ``Host`` header: behind an SSH tunnel that is the tunnel's port). ``/api/status`` does
much more than count, so the answer is cached for 15 s, failures included, and refreshed in the
background: the route never waits for it. It needs the route to run inside the server
(``plugins.isolation: in_process``, the default); in the plugin host there is no address to ask,
and the count is left out. It is a total: no per-client breakdown.

The process count is every Hermes executable running on the box, any profile: ``hermes``
(per subcommand: ``serve``, ``chat``, ``gateway``…), ``hermes-agent``, ``hermes-acp``, or a
python running one of them. A Hermes started by another Hermes (the Windows launcher's python
child, the TUI's ``tui_gateway``, an agent running ``hermes`` from its terminal) counts under
its top-level ancestor. The Electron Desktop (``Hermes``, capitalised) is not counted. The scan
is cached for 5 s and refreshed in the background, so it never blocks a request either: the first
answer after a start can omit the count.

``?skip=clients,processes`` leaves those counts out and does not measure them: the chip asks
for it when they are switched off in its settings (the TUI passes ``VITALS_SKIP``).

Only load figures, the hostname, the waited/free figures and the session / per-command counts
leave this process: no session ids, process list, paths or env. Fail-open by contract: without
psutil the route answers ``{"ok": false}``, an unreadable load figure is omitted and the others
still answer, and an unreachable ``/api/status``, unreadable process table or unreadable
``/proc`` file just omits that field.

The dashboard loader imports this file as a top-level module, so it stays self-contained. The TUI
widget (``src/tui.src.mjs``) inlines it too and runs it as ``python -c``: ``stream()`` prints the
same body as a JSON line every 3 s.
"""

from __future__ import annotations

import json
import logging
import math
import os
import platform
import re
import threading
import time
import urllib.request
from collections import Counter
from typing import Any, Iterable

logger = logging.getLogger(__name__)

try:  # FastAPI exists in the serve/dashboard env, not in the plugin's unit-test env.
    from fastapi import APIRouter, Request

    router = APIRouter()
except ImportError:  # pragma: no cover - unit env without FastAPI
    router = None

try:
    import psutil
except ImportError:  # pragma: no cover - psutil is a Hermes core dependency
    psutil = None
else:
    try:
        # cpu_percent(interval=None) measures since the previous call; prime it so the first poll
        # reports a real figure instead of 0.0, and the route never blocks a worker thread.
        psutil.cpu_percent(interval=None)
    except Exception:  # pragma: no cover - a broken primer must not stop the plugin loading
        pass


def collect_stats(ps: Any = psutil) -> dict[str, Any]:
    """The load figures, each measured independently: one unreadable figure never hides the others."""
    if ps is None:
        return {"ok": False}

    stats: dict[str, Any] = {"ok": True}

    try:
        hostname = platform.node()
    except Exception as exc:  # pragma: no cover - platform.node is effectively infallible
        logger.debug("hermes-vitals-light: hostname unreadable: %s", exc)
    else:
        if hostname:
            stats["hostname"] = hostname

    cpu_count = os.cpu_count()
    if cpu_count:
        stats["cpu_count"] = cpu_count

    try:
        stats["cpu_percent"] = ps.cpu_percent(interval=None)
    except Exception as exc:
        logger.debug("hermes-vitals-light: cpu_percent unreadable: %s", exc)

    try:
        vm = ps.virtual_memory()
        stats["memory"] = {"total": vm.total, "used": vm.total - vm.available, "percent": vm.percent}
    except Exception as exc:
        logger.debug("hermes-vitals-light: virtual_memory unreadable: %s", exc)

    getloadavg = getattr(ps, "getloadavg", None)
    if getloadavg is not None:
        try:
            stats["load_avg"] = [round(v, 2) for v in getloadavg()]
        except Exception as exc:
            logger.debug("hermes-vitals-light: load average unreadable: %s", exc)

    if "cpu_percent" not in stats and "memory" not in stats:
        return {"ok": False}
    return stats


WAITED_STUCK_SECONDS = 25
WAITED_BUSY_SECONDS = 10
LOW_FREE_BYTES = 1024 * 1024**2


def parse_pressure(text: str) -> float | None:
    """The ``avg60`` value of the ``some`` line in ``/proc/pressure/cpu`` text."""
    for line in text.splitlines():
        fields = line.split()
        if not fields or fields[0] != "some":
            continue
        for field in fields[1:]:
            if field.startswith("avg60="):
                try:
                    value = float(field.partition("=")[2])
                except ValueError:
                    return None
                return value if math.isfinite(value) else None
    return None


def parse_meminfo(text: str) -> int | None:
    """``MemAvailable`` from ``/proc/meminfo`` text, in bytes (the file is in KiB)."""
    for line in text.splitlines():
        if line.startswith("MemAvailable:"):
            fields = line.split()
            if len(fields) < 2:
                return None
            try:
                return int(fields[1]) * 1024
            except ValueError:
                return None
    return None


def waited_verdict(seconds: int, free: int | None) -> str:
    """``stuck`` / ``busy`` / ``ok`` from waited seconds and MemAvailable bytes."""
    if seconds >= WAITED_STUCK_SECONDS or (free is not None and free < LOW_FREE_BYTES):
        return "stuck"
    if seconds >= WAITED_BUSY_SECONDS:
        return "busy"
    return "ok"


def read_pressure() -> dict[str, Any]:
    """One stateless read of ``/proc/pressure/cpu`` and ``/proc/meminfo``; omit what is unreadable."""
    pressure_text = meminfo_text = None
    try:
        with open("/proc/pressure/cpu", encoding="ascii", errors="replace") as pressure:
            pressure_text = pressure.read()
    except OSError:
        pass
    try:
        with open("/proc/meminfo", encoding="ascii", errors="replace") as meminfo:
            meminfo_text = meminfo.read()
    except OSError:
        pass

    avg60 = parse_pressure(pressure_text) if pressure_text is not None else None
    free = parse_meminfo(meminfo_text) if meminfo_text is not None else None
    result: dict[str, Any] = {}
    if free is not None:
        result["free"] = free
    if avg60 is not None:
        seconds = round(avg60 * 0.6)
        result["waited"] = {"seconds": seconds, "verdict": waited_verdict(seconds, free)}
    return result


# ``/api/status`` also checks the config version, probes the gateway and lists the profiles and
# components, so it is asked about every STATUS_TTL seconds, not at the chip's 3 s cadence.
STATUS_TTL = 15.0
_STATUS_TIMEOUT = 2.0
_no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback never goes through a proxy
# url -> (asked at, total or None). A failed ask is cached too, so an unreachable
# server is not hammered on every poll.
_status_cache: dict[str, tuple[float, int | None]] = {}
_status_lock = threading.Lock()
_status_refreshing: set[str] = set()


def _start_thread(target: Any) -> None:
    threading.Thread(target=target, name="hermes-vitals-light-refresh", daemon=True).start()


def status_url(scope: dict[str, Any]) -> str | None:
    """``/api/status`` of the server a request reached, from the socket it arrived on.

    Not the ``Host`` header: a client behind an SSH tunnel names the tunnel's local port.
    """
    server = scope.get("server")
    if not server or not server[1]:  # a unix socket has no port
        return None
    host = server[0]
    host = "127.0.0.1" if host in ("0.0.0.0", "") else "[::1]" if ":" in host else host
    scheme = "https" if scope.get("scheme") in ("https", "wss") else "http"
    return f"{scheme}://{host}:{server[1]}/api/status"


def active_sessions(url: str, clock: Any = time.monotonic) -> int | None:
    """Hermes's ``active_sessions`` from ``url``, or None when it cannot be read (cached, failures too)."""
    with _status_lock:
        cached = _status_cache.get(url)
    if cached is not None and clock() - cached[0] < STATUS_TTL:
        return cached[1]

    total = None
    try:
        with _no_proxy.open(url, timeout=_STATUS_TIMEOUT) as response:
            total = json.load(response).get("active_sessions")
    except Exception as exc:  # OSError, HTTPException, ValueError, AttributeError: not a JSON object…
        logger.debug("hermes-vitals-light: /api/status unreadable: %s", exc)
    if isinstance(total, bool) or not isinstance(total, int):
        total = None
    with _status_lock:
        _status_cache[url] = (clock(), total)
    return total


def _refresh_status_async(url: str, clock: Any = time.monotonic, start: Any = _start_thread) -> None:
    """Refresh ``/api/status`` in the background, once per URL; a request never waits for it."""
    with _status_lock:
        if url in _status_refreshing:
            return
        _status_refreshing.add(url)

    def refresh() -> None:
        try:
            active_sessions(url, clock=clock)
        finally:
            with _status_lock:
                _status_refreshing.discard(url)

    try:
        start(refresh)
    except Exception as exc:  # thread creation failure must not fail the route
        logger.debug("hermes-vitals-light: status refresh not started: %s", exc)
        with _status_lock:
            _status_refreshing.discard(url)


def cached_active_sessions(url: str, clock: Any = time.monotonic, start: Any = _start_thread) -> int | None:
    """The cached session total, refreshed in the background; None on the first ask for a URL."""
    with _status_lock:
        cached = _status_cache.get(url)

    if cached is not None and clock() - cached[0] < STATUS_TTL:
        return cached[1]

    _refresh_status_async(url, clock=clock, start=start)
    return cached[1] if cached is not None else None


# Console scripts from Hermes' pyproject; None means "read the subcommand from argv".
_CONSOLE_SCRIPTS = {"hermes": None, "hermes-agent": "agent", "hermes-acp": "acp"}
_MODULES = {"hermes_cli.main": None, "agent.legacy_cli": "agent", "acp_adapter.entry": "acp", "tui_gateway.entry": "tui"}
_PYTHON = re.compile(r"^pythonw?(\d+(\.\d+)?)?$")


def _stem(path: str) -> str:
    name = re.split(r"[\\/]", path)[-1]
    return name[:-4] if name.lower().endswith(".exe") else name


def _subcommand(args: list[str]) -> str:
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg in ("-p", "--profile"):
            skip = True
        elif not arg.startswith("-"):
            return arg
    return "chat"  # bare `hermes` opens a chat


def hermes_command(argv: list[str] | None) -> str | None:
    """The Hermes command a process runs (``serve``, ``chat``, ``acp``…), or None if it is not Hermes.

    Case-sensitive on purpose: the console scripts are lowercase, the Electron Desktop is ``Hermes``.
    """
    if not argv:
        return None
    rest = list(argv[1:])
    stem = _stem(argv[0])
    if _PYTHON.match(stem.lower()):
        while rest and rest[0].startswith("-") and rest[0] != "-m":
            del rest[: 2 if rest[0] in ("-X", "-W") else 1]  # interpreter flags (-u, -X utf8…)
        if len(rest) >= 2 and rest[0] == "-m" and rest[1] in _MODULES:
            fixed, rest = _MODULES[rest[1]], rest[2:]
        elif rest and _stem(rest[0]) in _CONSOLE_SCRIPTS:
            fixed, rest = _CONSOLE_SCRIPTS[_stem(rest[0])], rest[1:]
        else:
            return None
    elif stem in _CONSOLE_SCRIPTS:
        fixed = _CONSOLE_SCRIPTS[stem]
    else:
        return None
    return fixed or _subcommand(rest)


def count_hermes_processes(procs: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Count top-level Hermes processes per command from ``{"pid", "ppid", "cmdline"}`` rows."""
    parents: dict[int, int] = {}
    commands: dict[int, str] = {}
    for info in procs:
        pid = info.get("pid")
        if pid is None:
            continue
        parents[pid] = info.get("ppid") or 0
        command = hermes_command(info.get("cmdline"))
        if command is not None:
            commands[pid] = command

    def under_another_hermes(pid: int) -> bool:
        seen = {pid}
        parent = parents.get(pid, 0)
        while parent and parent not in seen:
            if parent in commands:
                return True
            seen.add(parent)
            parent = parents.get(parent, 0)
        return False

    by_command = Counter(cmd for pid, cmd in commands.items() if not under_another_hermes(pid))
    return {"total": sum(by_command.values()), "by_command": dict(sorted(by_command.items()))}


# The figures a client can switch off server-side: the load figures cost one psutil call, the
# counts a ``/api/status`` call (every STATUS_TTL) and a full process scan (~50 ms of CPU per scan
# on 500 processes).
SKIPPABLE = ("clients", "processes")


def parse_skip(value: str | None) -> frozenset[str]:
    """``"clients,processes"`` -> the skippable names in it; unknown names are ignored."""
    return frozenset(name.strip() for name in (value or "").split(",")) & frozenset(SKIPPABLE)


# The process scan is the expensive figure, and the first one can take seconds
# on Windows. Keep the last answer; when it is stale, one background scan runs
# and requests keep returning the previous count instead of waiting.
PROCESS_TTL = 5.0
_process_cache: tuple[float, dict[str, Any] | None] = (0.0, None)
_process_lock = threading.Lock()


def _scan_hermes_processes() -> dict[str, Any] | None:
    if psutil is None:
        return None
    try:
        rows = (p.info for p in psutil.process_iter(["pid", "ppid", "cmdline"]))
        return count_hermes_processes(rows)
    except Exception as exc:  # psutil.Error, OSError: the chip just loses the count
        logger.debug("hermes-vitals-light: process table unreadable: %s", exc)
        return None


def cached_process_count(now: Any = time.monotonic, start: Any = _start_thread) -> dict[str, Any] | None:
    """The last process count; a stale answer is returned while one background scan runs."""
    global _process_cache
    asked, value = _process_cache
    if now() - asked < PROCESS_TTL:
        return value
    if not _process_lock.acquire(blocking=False):
        return value

    def refresh() -> None:
        global _process_cache
        try:
            _process_cache = (now(), _scan_hermes_processes())
        finally:
            _process_lock.release()

    try:
        start(refresh)
    except Exception as exc:  # thread creation failure must not fail the route
        logger.debug("hermes-vitals-light: process scan not started: %s", exc)
        _process_lock.release()
        return value
    return value


def snapshot(clients: bool = True, processes: bool = True, url: str | None = None) -> dict[str, Any]:
    """The ``/stats`` body: load figures, then the session and process counts asked for, when readable.

    ``url`` is the server's ``/api/status``; without one (the TUI feed has no server) there is no session count.
    The counts come from caches refreshed in the background, so this never waits for the process table or
    ``/api/status``: the first answer after a start can simply omit them. ``waited`` and ``free`` come from
    the two-file PSI/meminfo read and are likewise omitted when unreadable.
    """
    try:
        body = collect_stats()
        if not body.get("ok"):
            return body
        pressure = read_pressure()
        if "waited" in pressure:
            body["waited"] = pressure["waited"]
        if "free" in pressure:
            body["free"] = pressure["free"]
        if clients and url:
            total = cached_active_sessions(url)
            if total is not None:
                body["clients"] = {"total": total}
        if processes and psutil is not None:
            counts = cached_process_count()
            if counts is not None:
                body["processes"] = counts
        return body
    except Exception as exc:  # fail-open by contract, including unexpected psutil or cache errors
        logger.debug("hermes-vitals-light: stats unavailable: %s", exc)
        return {"ok": False}


def stream(interval: float = 3.0, out: Any = None, skip: frozenset[str] = frozenset()) -> None:
    """One ``snapshot()`` JSON line per ``interval``: the TUI widget's feed (``python -c`` on this file).

    The first line leaves out the process count, then the scan runs in the background: on Windows
    the first full scan takes seconds (~13 s for 750 processes), later ones a tenth of a second.
    The load figures never wait for it. ``skip`` drops counts for good (the figures the card
    hides). Ends when the reader goes away: a closed pipe, or a parent that died without closing it.
    """
    import json
    import sys
    import time

    out = out or sys.stdout
    parent = os.getppid()
    time.sleep(min(interval, 0.5))  # give the first cpu_percent (primed at import) a real window
    first = True
    while True:
        try:
            body = snapshot(clients="clients" not in skip, processes=not first and "processes" not in skip)
            out.write(json.dumps(body) + "\n")
            out.flush()
        except (BrokenPipeError, OSError, ValueError):  # ValueError: write to a closed file
            return
        first = False
        time.sleep(interval)
        if os.getppid() != parent:
            return


if router is not None:

    # ``?skip=clients,processes``: the counts the chip hides are not measured at all.
    @router.get("/stats")
    def stats(request: Request, skip: str = "") -> dict[str, Any]:
        skipped = parse_skip(skip)
        return snapshot(
            clients="clients" not in skipped,
            processes="processes" not in skipped,
            url=status_url(request.scope),
        )


if __name__ == "__main__":
    stream(float(os.environ.get("VITALS_INTERVAL", "3")), skip=parse_skip(os.environ.get("VITALS_SKIP")))
