"""hermes-vitals-light backend, mounted at ``/api/plugins/hermes-vitals-light/``.

One read-only route, ``GET /stats``: CPU and memory of the machine running the Hermes backend the
Desktop is connected to (``hermes serve`` runs this file in-process, so a remote gateway reports
the remote box, not the Desktop's), plus how many sessions are active right now.

``waited`` is Linux PSI CPU pressure: the ``some avg60`` field of ``/proc/pressure/cpu`` scaled
to the seconds of the last minute at least one task was runnable but stalled waiting for a CPU
(``round(avg60 * 0.6)``). ``free`` is ``MemAvailable`` from ``/proc/meminfo`` on Linux and
psutil's available RAM on macOS and Windows, so the chip still has a free-memory figure there.
The Linux figures come from one stateless two-file read with no psutil, subprocess or cache; an
unreadable file omits just its figure. ``waited`` is omitted where the kernel has no PSI (macOS,
Windows, containers without it). The verdict is ``stuck`` at 25 waited seconds or less than 1 GiB
free, ``busy`` at 10 waited seconds, and ``ok`` otherwise.

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
python running one of them. A Hermes folds into its parent only when that parent is a Hermes
candidate too: the chain has to be contiguous in Hermes processes (the Windows launcher and its
python child, a ``tui_gateway`` started directly by the ``hermes`` that spawned it), and the walk
stops at the first parent that is not one. So a ``hermes serve`` a shell launched from an agent's
terminal — a non-Hermes process between it and the Hermes that ultimately started it — is counted
on its own, which is the figure 0.1.1 showed. The Electron Desktop (``Hermes``, capitalised) is
not counted. The scan reads the process names first and a candidate's argv second, and resolves a
parent only when two Hermes candidates could be nested: asking Windows for the parent of every
process walks the whole handle table (seconds of CPU, GIL held, which stalls the event loop of the
``hermes serve`` it measures). Those parents come from one snapshot of the table where psutil
exposes ``ppid_map`` (Windows) and from one handle per visited pid elsewhere. The scan is cached
for 5 s and refreshed in the background, so it never blocks a request either: the first answer
after a start can omit the count.

``?skip=clients,processes`` leaves those counts out and does not measure them: the chip asks
for it when they are switched off in its settings (the TUI passes ``VITALS_SKIP``).

Only load figures, the hostname, the waited/free figures and the session / per-command counts
leave this process: no session ids, process list, paths or env. Fail-open by contract: without
psutil the route answers ``{"ok": false}``, an unreadable load figure is omitted and the others
still answer, and an unreachable ``/api/status``, unreadable process table or unreadable
``/proc`` file just omits that field.

The dashboard loader imports this file as a top-level module, so it stays self-contained. The TUI
widget (``src/tui.src.mjs``) inlines it too and runs it as ``python -c``: ``stream()`` prints the
same body as a JSON line every 3 s. That entry point (``__name__ == "__main__"``) serves no route,
so it builds no router and imports neither FastAPI (25 MB of RSS on import, pydantic and starlette
with it) nor ``urllib.request`` (4.6 MB): both are only reachable from the route, which only the
dashboard path defines.
"""

from __future__ import annotations

import json
import logging
import math
import os
import platform
import re
import sys
import threading
import time
from collections import Counter
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # annotations only: `from __future__ import annotations` keeps them strings
    from typing import Any, Callable, Iterable

logger = logging.getLogger(__name__)

# The TUI feed runs this file as `python -c`, so `__main__` is the stream entry point: it serves no
# route, and importing FastAPI there would cost the child ~25 MB of RSS for nothing. The dashboard
# loader imports the file as a top-level module instead and needs the router. FastAPI exists in the
# serve/dashboard env, not in the plugin's unit-test env, hence the guard.
if __name__ == "__main__":
    router = None
else:
    try:
        from fastapi import APIRouter, Request, Response

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
    """The load figures, each measured independently: one unreadable figure never hides the others.

    ``free`` is psutil's available RAM so macOS and Windows servers get the same figure as Linux
    (where ``read_pressure`` replaces it with ``MemAvailable``).
    """
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
        available = getattr(vm, "available", None)
        if (
            isinstance(available, (int, float))
            and not isinstance(available, bool)
            and math.isfinite(available)
            and available >= 0
        ):
            stats["free"] = int(available)
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


def read_pressure(system: str = sys.platform) -> dict[str, Any]:
    """One stateless read of Linux's ``/proc/pressure/cpu`` and ``/proc/meminfo``.

    On macOS and Windows the result is empty without touching the filesystem: the caller keeps
    psutil's ``free`` and omits ``waited``.
    """
    if not system.startswith("linux"):
        return {}

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
# /api/status is heavy; tunable via VITALS_STATUS_TTL (seconds).
STATUS_TTL = float(os.environ.get("VITALS_STATUS_TTL", "15.0"))
_STATUS_TIMEOUT = 2.0
# url -> (asked at, total or None). A failed ask is cached too, so an unreachable
# server is not hammered on every poll.
_status_cache: dict[str, tuple[float, int | None]] = {}
_status_lock = threading.Lock()
_status_refreshing: set[str] = set()
# Built on the first ask rather than at import: ``urllib.request`` costs ~4.6 MB of RSS and only the
# route ever asks (the stream entry point passes no URL, so it has no server to ask).
_no_proxy = None


def _status_opener() -> Any:
    """The ``/api/status`` opener, imported and built once: loopback never goes through a proxy."""
    global _no_proxy
    if _no_proxy is None:
        import urllib.request

        with _status_lock:  # the first thread to ask builds it, the others reuse it
            if _no_proxy is None:
                _no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return _no_proxy


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
        with _status_opener().open(url, timeout=_STATUS_TIMEOUT) as response:
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


def count_hermes_processes(
    procs: Iterable[dict[str, Any]],
    parents: Callable[[int], int | None] | None = None,
) -> dict[str, Any]:
    """Count top-level Hermes processes per command from ``{"pid", "cmdline"}`` rows.

    A row may carry its ``ppid``; when it does not, ``parents`` is asked for one, lazily, and
    only for a candidate whose parent decides whether it folds. That keeps this function pure: it
    never touches psutil itself, ``_scan_hermes_processes`` passes it the resolver.

    A process folds into its parent only when that parent is itself a Hermes candidate: the chain
    has to be contiguous in Hermes processes (the Windows launcher and its python child, a
    ``tui_gateway`` started directly by the ``hermes`` that spawned it). The walk stops at the
    first parent that is not a candidate, so a ``hermes serve`` a shell launched from an agent's
    terminal stays a count of its own instead of folding into a distant Hermes ancestor.
    """
    given: dict[int, int] = {}
    commands: dict[int, str] = {}
    for info in procs:
        pid = info.get("pid")
        if pid is None:
            continue
        ppid = info.get("ppid")
        if ppid is not None:
            given[pid] = ppid
        command = hermes_command(info.get("cmdline"))
        if command is not None:
            commands[pid] = command

    memo: dict[int, int] = {}

    def parent_of(pid: int) -> int:
        """The parent of a visited pid: from its row, or asked once and remembered."""
        if pid in given:
            return given[pid] or 0
        if pid not in memo:
            ppid = None
            if parents is not None:
                try:
                    ppid = parents(pid)
                except Exception:  # psutil.Error, OSError: an unreadable parent is a root
                    ppid = None
            memo[pid] = ppid or 0
        return memo[pid]

    def under_another_hermes(pid: int) -> bool:
        parent = parent_of(pid)
        return bool(parent) and parent != pid and parent in commands

    # Nesting needs two Hermes processes; with one (or none) there is no walk to do, so no
    # parent is read at all: the expensive half of the scan is skipped unless it can matter.
    counted = [pid for pid in commands if len(commands) < 2 or not under_another_hermes(pid)]
    by_command = Counter(commands[pid] for pid in counted)
    return {"total": sum(by_command.values()), "by_command": dict(sorted(by_command.items()))}


# The figures a client can switch off server-side: the load figures cost one psutil call, the
# counts a ``/api/status`` call (every STATUS_TTL) and a name-only pass over the process table
# (every PROCESS_TTL).
SKIPPABLE = ("clients", "processes")


def parse_skip(value: str | None) -> frozenset[str]:
    """``"clients,processes"`` -> the skippable names in it; unknown names are ignored."""
    return frozenset(name.strip() for name in (value or "").split(",")) & frozenset(SKIPPABLE)


# The process scan is the expensive figure, and the first one can take seconds
# on Windows. Keep the last answer; when it is stale, one background scan runs
# and requests keep returning the previous count instead of waiting.
# Tunable via VITALS_PROCESS_TTL (seconds) so a loaded server can scan less often.
PROCESS_TTL = float(os.environ.get("VITALS_PROCESS_TTL", "5.0"))
_process_cache: tuple[float, dict[str, Any] | None] = (0.0, None)
_process_lock = threading.Lock()


# Only processes that can plausibly be Hermes need their cmdline read; reading
# argv for every process on the box (the old single pass) held the GIL for
# seconds on a loaded server and stalled the event loop.
_HERMES_PROCESS_NAMES = frozenset({"hermes", "hermes-agent", "hermes-acp"})


def _is_candidate_name(name: str) -> bool:
    """Whether a bare process name can be Hermes: a console script or a python.

    psutil names the executable alone, ``python.exe`` on Windows: the extension is
    dropped first, the same way ``hermes_command`` normalises ``argv[0]``.
    """
    stem = _stem(name or "").lower()
    return stem in _HERMES_PROCESS_NAMES or bool(_PYTHON.match(stem))


def _ppid_of(pid: int) -> int | None:
    """The parent of one pid, on demand: one process handle, not the whole table."""
    try:
        return psutil.Process(pid).ppid()
    except Exception:  # psutil.Error (NoSuchProcess, AccessDenied), OSError
        return None


def _windows_ppid_map() -> dict[int, int] | None:
    """Every pid's parent from one snapshot on Windows, or None when psutil has no such map.

    ``Process.ppid()`` rebuilds that map for the whole table on every call on Windows (psutil
    7.2.2: ~11 ms each, so the 19 visited pids of a 2-hermes scan cost ~220 ms), while
    ``_pswindows.ppid_map()`` answers all of them from one snapshot (~11 ms). It is a **private**
    accessor: the import fails on macOS and Linux, and a psutil release that renames or drops it
    raises here too. Both are caught, and the scan then falls back to ``_ppid_of``, one handle per
    pid: the count is identical, only the headroom of the snapshot is lost.
    """
    try:
        from psutil import _pswindows

        table = _pswindows.ppid_map()
    except Exception:  # ImportError off Windows; AttributeError / OSError after a psutil bump
        return None
    return table if isinstance(table, dict) else None


def _parent_resolver(system: str = sys.platform) -> Callable[[int], int | None]:
    """The parent resolver for one scan, built on the first pid asked for.

    Lazy on purpose: ``count_hermes_processes`` never asks with fewer than two Hermes candidates,
    so a scan that cannot fold anything does not even take the parent snapshot.
    """
    table: dict[int, int] | None = None
    asked = False

    def parent_of(pid: int) -> int | None:
        nonlocal table, asked
        if not asked:
            asked = True
            if system.startswith("win"):
                table = _windows_ppid_map()
        if table is not None:
            return table.get(pid)
        return _ppid_of(pid)

    return parent_of


def _scan_hermes_processes(system: str = sys.platform) -> dict[str, Any] | None:
    """Count Hermes processes without asking the table for a parent it does not need.

    ``ppid`` is deliberately absent from the first pass: on Windows psutil rebuilds the parent
    map of every process to answer it (``psutil_windows.ppid_map``: ~8 s of the ~8.3 s first
    scan over 535 processes, with the GIL held, which stalls the event loop of the server this
    measures). Names alone cost milliseconds; a parent is resolved only for a Hermes candidate,
    once per scan from ``_parent_resolver`` (one table snapshot on Windows, one handle per visited
    pid elsewhere), and not at all unless two Hermes candidates exist.

    A candidate folds into its parent only when that parent is a candidate too: the chain has to
    be contiguous, so the Windows launcher and its python child count once while a ``hermes``
    started by a shell from an agent's terminal counts on its own.
    """
    if psutil is None:
        return None
    try:
        # First pass: names only (no argv, no parent).
        candidates: list[tuple[int, Any]] = []
        for proc in psutil.process_iter(["pid", "name"]):
            info = getattr(proc, "info", None)
            if not isinstance(info, dict):
                continue
            pid = info.get("pid")
            if pid is None:
                continue
            if _is_candidate_name(info.get("name") or ""):
                candidates.append((pid, proc))

        # Second pass: read argv only for the handful of candidates above.
        rows: list[dict[str, Any]] = []
        for pid, proc in candidates:
            try:
                cmdline = proc.cmdline()
            except Exception:  # psutil.NoSuchProcess, AccessDenied, OSError
                cmdline = []
            rows.append({"pid": pid, "cmdline": cmdline})

        # Parents stay lazy, and a candidate's parent is only ever asked for here: a non-Hermes
        # parent ends the chain (the shell an agent's terminal used), so no other pid is walked.
        return count_hermes_processes(rows, _parent_resolver(system))
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
    ``/api/status``: the first answer after a start can simply omit them. ``waited`` comes from the PSI
    read and is omitted where the kernel has no PSI; ``free`` falls back to psutil's available RAM on
    those platforms and is likewise omitted when every source is unreadable.
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
        waited = body.get("waited")
        if isinstance(waited, dict) and isinstance(waited.get("seconds"), int):
            # The verdict follows the free figure actually returned, including psutil's fallback
            # when /proc/meminfo was unreadable.
            waited["verdict"] = waited_verdict(waited["seconds"], body.get("free"))
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
    def stats(request: Request, response: Response, skip: str = "") -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        skipped = parse_skip(skip)
        return snapshot(
            clients="clients" not in skipped,
            processes="processes" not in skipped,
            url=status_url(request.scope),
        )


if __name__ == "__main__":
    stream(float(os.environ.get("VITALS_INTERVAL", "3")), skip=parse_skip(os.environ.get("VITALS_SKIP")))
