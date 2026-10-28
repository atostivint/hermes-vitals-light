"""Backend half: shape of /stats, and (when a Hermes checkout is given) the route on a real FastAPI app.

Plain unittest, no Hermes needed for the unit tests:
    python -m unittest discover -s test -p "test_*.py"
End-to-end with the real psutil and FastAPI from the Hermes environment:
    HERMES_AGENT_SRC=<hermes-agent checkout> <hermes venv python> -m unittest discover -s test -p "test_*.py"
"""

import importlib.util
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SRC = os.environ.get("HERMES_AGENT_SRC")

# The RealRoute tests mount the router on a real FastAPI app: they need psutil, FastAPI and
# httpx (all present in a Hermes environment). A checkout in HERMES_AGENT_SRC is optional, it
# is only added to sys.path.
try:
    import fastapi  # noqa: F401
    import httpx  # noqa: F401
    import psutil  # noqa: F401
except ImportError:
    ROUTE_DEPS = False
else:
    ROUTE_DEPS = True


def load_plugin_api():
    # Same way the dashboard loads it: a standalone module from its file path.
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_hermes_vitals_light", ROOT / "dashboard/plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakePsutil:
    def __init__(self, loadavg=True):
        if loadavg:
            self.getloadavg = lambda: (1.234, 0.5, 0.25)

    def virtual_memory(self):
        return SimpleNamespace(total=1000, available=250, percent=75.0)

    def cpu_percent(self, interval=None):
        assert interval is None, "the route must not block a worker thread"
        return 42.0


class CollectStats(unittest.TestCase):
    def test_only_load_figures_and_hostname_leave_the_process(self):
        stats = load_plugin_api().collect_stats(FakePsutil())

        self.assertEqual(set(stats), {"ok", "hostname", "cpu_percent", "cpu_count", "memory", "load_avg"})
        self.assertEqual(stats["cpu_percent"], 42.0)
        self.assertEqual(stats["memory"], {"total": 1000, "used": 750, "percent": 75.0})
        self.assertEqual(stats["load_avg"], [1.23, 0.5, 0.25])

    def test_a_host_without_load_average_omits_it(self):
        self.assertNotIn("load_avg", load_plugin_api().collect_stats(FakePsutil(loadavg=False)))

    def test_without_psutil_the_route_fails_open(self):
        self.assertEqual(load_plugin_api().collect_stats(None), {"ok": False})

    def test_an_unreadable_figure_does_not_hide_the_others(self):
        class BrokenMemory(FakePsutil):
            def virtual_memory(self):
                raise OSError("no memory table")

        stats = load_plugin_api().collect_stats(BrokenMemory())

        self.assertTrue(stats["ok"])
        self.assertEqual(stats["cpu_percent"], 42.0)
        self.assertNotIn("memory", stats)

    def test_a_broken_load_average_keeps_cpu_and_memory(self):
        class BrokenLoad(FakePsutil):
            def __init__(self):
                super().__init__(loadavg=False)

            def getloadavg(self):
                raise OSError("no load average")

        stats = load_plugin_api().collect_stats(BrokenLoad())

        self.assertTrue(stats["ok"])
        self.assertIn("cpu_percent", stats)
        self.assertIn("memory", stats)
        self.assertNotIn("load_avg", stats)

    def test_when_every_load_figure_is_unreadable_it_fails_open(self):
        class Broken(FakePsutil):
            def cpu_percent(self, interval=None):
                raise OSError("no cpu")

            def virtual_memory(self):
                raise OSError("no memory")

        self.assertEqual(load_plugin_api().collect_stats(Broken()), {"ok": False})


class Pressure(unittest.TestCase):
    PRESSURE = (
        "some avg10=0.00 avg60=21.35 avg300=20.00 total=179000000\n"
        "full avg10=0.00 avg60=20.00 avg300=19.00 total=170000000\n"
    )
    MEMINFO = "MemTotal: 8123456 kB\nMemFree: 1000000 kB\nMemAvailable: 3891234 kB\n"

    def fake_open(self, pressure=True, meminfo=True):
        import io

        def opener(path, *args, **kwargs):
            if path == "/proc/pressure/cpu" and pressure:
                return io.StringIO(self.PRESSURE)
            if path == "/proc/meminfo" and meminfo:
                return io.StringIO(self.MEMINFO)
            raise OSError(f"missing {path}")

        return opener

    def test_parse_pressure_reads_the_some_avg60(self):
        api = load_plugin_api()

        self.assertEqual(api.parse_pressure(self.PRESSURE), 21.35)
        self.assertIsNone(api.parse_pressure("full avg10=0 avg60=1 avg300=1 total=1"))
        self.assertIsNone(api.parse_pressure("some avg10=0 avg60=nope avg300=1 total=1"))
        self.assertIsNone(api.parse_pressure("some avg10=0 avg60=nan avg300=1 total=1"))

    def test_parse_meminfo_reads_memavailable_in_bytes(self):
        api = load_plugin_api()

        self.assertEqual(api.parse_meminfo(self.MEMINFO), 3891234 * 1024)
        self.assertIsNone(api.parse_meminfo("MemTotal: 8123456 kB\n"))

    def test_waited_verdict_thresholds(self):
        api = load_plugin_api()

        self.assertEqual(api.waited_verdict(25, None), "stuck")
        self.assertEqual(api.waited_verdict(24, None), "busy")
        self.assertEqual(api.waited_verdict(10, None), "busy")
        self.assertEqual(api.waited_verdict(9, None), "ok")
        self.assertEqual(api.waited_verdict(5, api.LOW_FREE_BYTES - 1), "stuck")
        self.assertEqual(api.waited_verdict(5, api.LOW_FREE_BYTES), "ok")

    def test_one_read_returns_waited_and_free(self):
        api = load_plugin_api()

        with mock.patch("builtins.open", side_effect=self.fake_open()) as opened:
            result = api.read_pressure()

        self.assertEqual(result["free"], 3891234 * 1024)
        self.assertEqual(result["waited"], {"seconds": 13, "verdict": "busy"})
        self.assertEqual(opened.call_count, 2, "one read is exactly the two /proc files")

    def test_missing_proc_files_omit_everything_without_raising(self):
        api = load_plugin_api()

        with mock.patch("builtins.open", side_effect=OSError("no /proc")):
            self.assertEqual(api.read_pressure(), {})

    def test_missing_pressure_keeps_free(self):
        api = load_plugin_api()

        with mock.patch("builtins.open", side_effect=self.fake_open(pressure=False)):
            result = api.read_pressure()

        self.assertEqual(result["free"], 3891234 * 1024)
        self.assertNotIn("waited", result)

    def test_missing_meminfo_keeps_waited(self):
        api = load_plugin_api()

        with mock.patch("builtins.open", side_effect=self.fake_open(meminfo=False)):
            result = api.read_pressure()

        self.assertEqual(result["waited"], {"seconds": 13, "verdict": "busy"})
        self.assertNotIn("free", result)


class SnapshotPressure(unittest.TestCase):
    def snapshot(self, pressure):
        api = load_plugin_api()
        api.collect_stats = lambda: {"ok": True}
        api.read_pressure = lambda: pressure

        return api.snapshot(processes=False)

    def test_waited_and_free_are_added_to_the_body(self):
        body = self.snapshot({"free": 4 * 1024**3, "waited": {"seconds": 15, "verdict": "busy"}})

        self.assertEqual(body["waited"], {"seconds": 15, "verdict": "busy"})
        self.assertEqual(body["free"], 4 * 1024**3)
        self.assertTrue(body["ok"])

    def test_missing_pressure_omits_the_fields(self):
        body = self.snapshot({})

        self.assertNotIn("waited", body)
        self.assertNotIn("free", body)


class FakeStatus:
    """A local HTTP server answering ``/api/status`` like Hermes does, and counting the asks."""

    def __init__(self, body=b'{"active_sessions": 3, "version": "x"}'):
        self.hits = 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.hits += 1
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}/api/status"

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


class StatusUrl(unittest.TestCase):
    def test_it_is_the_socket_the_request_arrived_on_not_the_host_header(self):
        status_url = load_plugin_api().status_url

        self.assertEqual(status_url({"server": ("127.0.0.1", 9119), "scheme": "http"}), "http://127.0.0.1:9119/api/status")
        self.assertEqual(status_url({"server": ("0.0.0.0", 9119), "scheme": "http"}), "http://127.0.0.1:9119/api/status")
        self.assertEqual(status_url({"server": ("::", 9119), "scheme": "http"}), "http://[::1]:9119/api/status")
        self.assertEqual(status_url({"server": ("10.0.0.5", 443), "scheme": "https"}), "https://10.0.0.5:443/api/status")

    def test_no_tcp_address_means_nothing_to_ask(self):
        status_url = load_plugin_api().status_url

        self.assertIsNone(status_url({"server": ("/run/hermes.sock", None)}))
        self.assertIsNone(status_url({}))


class ActiveSessions(unittest.TestCase):
    def test_it_reads_the_count_from_status_even_with_a_proxy_configured(self):
        with FakeStatus() as status, mock.patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "http_proxy": "http://127.0.0.1:1"}):
            self.assertEqual(load_plugin_api().active_sessions(status.url), 3)

    def test_the_answer_is_cached_for_the_ttl(self):
        api = load_plugin_api()
        now = [100.0]

        with FakeStatus() as status:
            self.assertEqual(api.active_sessions(status.url, clock=lambda: now[0]), 3)
            now[0] += api.STATUS_TTL - 1
            self.assertEqual(api.active_sessions(status.url, clock=lambda: now[0]), 3)
            self.assertEqual(status.hits, 1)
            now[0] += 2
            api.active_sessions(status.url, clock=lambda: now[0])
            self.assertEqual(status.hits, 2)

    def test_an_unreachable_server_is_none_and_is_not_asked_again_within_the_ttl(self):
        api = load_plugin_api()

        with mock.patch.object(api._no_proxy, "open", side_effect=OSError("refused")) as opened:
            self.assertIsNone(api.active_sessions("http://127.0.0.1:1/api/status", clock=lambda: 100.0))
            self.assertIsNone(api.active_sessions("http://127.0.0.1:1/api/status", clock=lambda: 101.0))
            self.assertEqual(opened.call_count, 1)

    def test_an_answer_that_is_not_a_count_is_none(self):
        for body in (b"[]", b"not json", b'{"active_sessions": "3"}', b'{"active_sessions": true}', b"{}"):
            with FakeStatus(body) as status:
                self.assertIsNone(load_plugin_api().active_sessions(status.url), body)

    def test_an_unexpected_reader_error_still_fails_open(self):
        api = load_plugin_api()

        with mock.patch.object(api._no_proxy, "open", side_effect=RuntimeError("boom")):
            self.assertIsNone(api.active_sessions("http://127.0.0.1:1/api/status", clock=lambda: 100.0))


class SnapshotClients(unittest.TestCase):
    def snapshot(self, **kwargs):
        api = load_plugin_api()
        api.collect_stats = lambda: {"ok": True}
        if kwargs.get("url") and kwargs.get("clients", True):
            api.active_sessions(kwargs["url"])  # warm the cache as an earlier poll would
        return api.snapshot(processes=False, **kwargs)

    def test_the_count_is_a_bare_total(self):
        with FakeStatus() as status:
            self.assertEqual(self.snapshot(url=status.url)["clients"], {"total": 3})

    def test_a_count_switched_off_is_never_asked(self):
        with FakeStatus() as status:
            self.assertNotIn("clients", self.snapshot(clients=False, url=status.url))
            self.assertEqual(status.hits, 0)

    def test_without_a_server_or_an_answer_the_count_is_left_out(self):
        self.assertNotIn("clients", self.snapshot())
        with FakeStatus(b"{}") as status:
            self.assertNotIn("clients", self.snapshot(url=status.url))


class CachedActiveSessions(unittest.TestCase):
    """The session count is served from the cache and refreshed in the background."""

    def test_the_first_call_omits_the_total_and_warms_the_cache(self):
        api = load_plugin_api()

        with FakeStatus() as status:
            self.assertIsNone(api.cached_active_sessions(status.url, start=lambda fn: fn()))
            self.assertEqual(api.cached_active_sessions(status.url, start=lambda fn: fn()), 3)
            self.assertEqual(status.hits, 1)

    def test_a_fresh_total_needs_no_refresh(self):
        api = load_plugin_api()

        with FakeStatus() as status:
            api.active_sessions(status.url)
            started = []
            self.assertEqual(
                api.cached_active_sessions(status.url, start=lambda fn: started.append(fn)),
                3,
            )
            self.assertEqual(status.hits, 1)
            self.assertEqual(started, [])

    def test_a_stale_total_is_returned_while_one_refresh_runs(self):
        api = load_plugin_api()
        now = [100.0]

        with FakeStatus() as status:
            api.active_sessions(status.url, clock=lambda: now[0])
            now[0] = 120.0
            started = []

            self.assertEqual(
                api.cached_active_sessions(status.url, clock=lambda: now[0], start=lambda fn: started.append(fn)),
                3,
            )
            self.assertEqual(status.hits, 1)
            self.assertEqual(len(started), 1)

            started[0]()
            self.assertEqual(status.hits, 2)
            self.assertEqual(
                api.cached_active_sessions(status.url, clock=lambda: now[0], start=lambda fn: started.append(fn)),
                3,
            )
            self.assertEqual(len(started), 1, "the fresh answer needs no second refresh")

    def test_two_requests_while_refreshing_start_only_one_refresh(self):
        api = load_plugin_api()

        with FakeStatus() as status:
            started = []
            api.cached_active_sessions(status.url, start=lambda fn: started.append(fn))
            api.cached_active_sessions(status.url, start=lambda fn: started.append(fn))
            self.assertEqual(len(started), 1)
            started[0]()  # let the recorded refresh finish


class CachedProcesses(unittest.TestCase):
    """The process scan is cached and never runs on the request path."""

    def api(self):
        api = load_plugin_api()
        api.psutil = mock.Mock()
        api.psutil.process_iter.return_value = []

        return api

    def test_the_first_call_returns_no_count_and_a_scan_fills_the_cache(self):
        api = self.api()
        start = lambda fn: fn()

        self.assertIsNone(api.cached_process_count(now=lambda: 100.0, start=start))
        self.assertEqual(api.cached_process_count(now=lambda: 100.0, start=start), {"total": 0, "by_command": {}})
        self.assertEqual(api.psutil.process_iter.call_count, 1)

    def test_a_fresh_count_is_returned_without_scanning(self):
        api = self.api()
        start = lambda fn: fn()

        api.cached_process_count(now=lambda: 100.0, start=start)
        self.assertEqual(
            api.cached_process_count(now=lambda: 104.0, start=start),
            {"total": 0, "by_command": {}},
        )
        self.assertEqual(api.psutil.process_iter.call_count, 1)

    def test_a_stale_count_is_kept_while_one_scan_runs(self):
        api = self.api()
        old = {"total": 2, "by_command": {"chat": 2}}
        api._process_cache = (100.0, old)
        started = []

        self.assertEqual(api.cached_process_count(now=lambda: 106.0, start=lambda fn: started.append(fn)), old)
        self.assertEqual(len(started), 1)
        self.assertEqual(api.cached_process_count(now=lambda: 107.0, start=lambda fn: started.append(fn)), old)
        self.assertEqual(len(started), 1)

        started[0]()
        self.assertEqual(api._process_cache[1], {"total": 0, "by_command": {}})
        self.assertEqual(api.psutil.process_iter.call_count, 1)

    def test_a_failed_scan_is_retried_after_the_ttl(self):
        api = self.api()
        api.psutil.process_iter.side_effect = OSError("denied")
        start = lambda fn: fn()

        self.assertIsNone(api.cached_process_count(now=lambda: 100.0, start=start))
        self.assertIsNone(api.cached_process_count(now=lambda: 101.0, start=start))
        self.assertEqual(api.psutil.process_iter.call_count, 1, "a failure is cached briefly too")

        self.assertIsNone(api.cached_process_count(now=lambda: 106.0, start=start))
        self.assertEqual(api.psutil.process_iter.call_count, 2)

    def test_the_route_never_scans_when_processes_are_switched_off(self):
        api = self.api()
        api.collect_stats = lambda: {"ok": True}

        self.assertNotIn("processes", api.snapshot(processes=False))
        api.psutil.process_iter.assert_not_called()


class HermesCommand(unittest.TestCase):
    def test_console_scripts_modules_and_shims_are_recognised(self):
        command = load_plugin_api().hermes_command
        cases = {
            ("/home/u/.local/bin/hermes", "serve", "--port", "9119"): "serve",
            ("hermes", "-p", "work", "gateway", "run"): "gateway",
            ("hermes",): "chat",
            (r"C:\Users\u\AppData\Local\hermes\venv\Scripts\hermes.exe", "--profile", "x"): "chat",
            ("/usr/bin/python3.12", "-u", "-m", "hermes_cli.main", "dashboard"): "dashboard",
            ("python3", "-X", "utf8", "/opt/hermes/bin/hermes", "chat"): "chat",
            (r"C:\venv\Scripts\python.exe", r"C:\venv\Scripts\hermes.exe", "serve"): "serve",
            ("hermes-acp",): "acp",
            ("python", "-m", "tui_gateway.entry"): "tui",
        }
        for argv, expected in cases.items():
            self.assertEqual(command(list(argv)), expected, argv)

    def test_the_desktop_and_unrelated_processes_are_not_hermes(self):
        command = load_plugin_api().hermes_command
        for argv in (
            [r"C:\Users\u\AppData\Local\hermes\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe"],
            ["/Applications/Hermes.app/Contents/MacOS/Hermes", "--type=renderer"],
            ["python3", "onenote_mcp_server.py"],
            ["python3", "-m", "http.server"],
            ["vim", "hermes.py"],
            [],
            None,
        ):
            self.assertIsNone(command(argv), argv)


class CountHermesProcesses(unittest.TestCase):
    def test_a_hermes_started_by_another_counts_under_its_top_level_ancestor(self):
        counts = load_plugin_api().count_hermes_processes([
            {"pid": 1, "ppid": 0, "cmdline": ["/sbin/init"]},
            {"pid": 10, "ppid": 1, "cmdline": ["hermes", "serve"]},
            # Windows launcher and its python child: one executable.
            {"pid": 20, "ppid": 1, "cmdline": ["hermes.exe", "chat"]},
            {"pid": 21, "ppid": 20, "cmdline": ["python.exe", "hermes.exe", "chat"]},
            # The TUI: hermes chat -> node -> tui_gateway.
            {"pid": 30, "ppid": 1, "cmdline": ["hermes", "--tui"]},
            {"pid": 31, "ppid": 30, "cmdline": ["node", "ui-tui/dist/entry.js"]},
            {"pid": 32, "ppid": 31, "cmdline": ["python", "-m", "tui_gateway.entry"]},
            {"pid": 40, "ppid": 99, "cmdline": ["hermes", "chat"]},  # parent already gone
            {"pid": 50, "ppid": 1, "cmdline": None},  # AccessDenied
            {"pid": 60, "ppid": 1, "cmdline": ["Hermes.exe"]},
        ])

        self.assertEqual(counts, {"total": 4, "by_command": {"chat": 3, "serve": 1}})

    def test_a_ppid_cycle_does_not_hang(self):
        counts = load_plugin_api().count_hermes_processes([
            {"pid": 1, "ppid": 2, "cmdline": ["bash"]},
            {"pid": 2, "ppid": 1, "cmdline": ["hermes", "serve"]},
        ])

        self.assertEqual(counts, {"total": 1, "by_command": {"serve": 1}})


class SnapshotFailOpen(unittest.TestCase):
    def test_an_unexpected_error_is_not_a_500(self):
        api = load_plugin_api()
        api.collect_stats = mock.Mock(side_effect=RuntimeError("boom"))

        self.assertEqual(api.snapshot(processes=False), {"ok": False})


class Stream(unittest.TestCase):
    """The TUI feed: one snapshot JSON line per tick, the first one without the slow process scan."""

    def run_stream(self, ticks, skip=frozenset()):
        import io
        import json

        api = load_plugin_api()
        calls = []

        def snapshot(clients=True, processes=True):
            calls.append((clients, processes) if skip else processes)
            return {"ok": True, "n": len(calls)}

        class Out(io.StringIO):
            def flush(self):
                if len(calls) >= ticks:
                    self.lines = [json.loads(line) for line in self.getvalue().splitlines()]
                    self.close()  # the reader goes away: the next write ends the stream

        out = Out()
        api.snapshot = snapshot
        with mock.patch("time.sleep"):
            api.stream(interval=3, out=out, skip=skip)
        return calls, out.lines

    def test_lines_until_the_reader_goes_away_and_the_first_skips_processes(self):
        calls, lines = self.run_stream(ticks=3)

        self.assertEqual(lines, [{"ok": True, "n": 1}, {"ok": True, "n": 2}, {"ok": True, "n": 3}])
        self.assertEqual(calls[:3], [False, True, True])

    def test_a_skipped_count_is_never_measured(self):
        calls, _ = self.run_stream(ticks=3, skip=frozenset({"processes"}))

        self.assertEqual(calls[:3], [(True, False)] * 3)

    def test_snapshot_without_processes_skips_the_scan(self):
        api = load_plugin_api()
        api.collect_stats = lambda: {"ok": True}
        api.psutil = mock.Mock()
        api.psutil.process_iter.return_value = []

        self.assertNotIn("processes", api.snapshot(processes=False))
        api.psutil.process_iter.assert_not_called()

        # The first request only starts the scan; a warm cache supplies the count.
        api.cached_process_count(start=lambda fn: fn())
        self.assertEqual(api.snapshot()["processes"], {"total": 0, "by_command": {}})

    def test_the_feed_has_no_server_so_no_session_count(self):
        api = load_plugin_api()
        api.collect_stats = lambda: {"ok": True}
        api.read_pressure = lambda: {}

        self.assertEqual(api.snapshot(clients=True, processes=False), {"ok": True})

    def test_skip_keeps_only_known_counts(self):
        parse = load_plugin_api().parse_skip

        self.assertEqual(parse("clients, processes"), {"clients", "processes"})
        self.assertEqual(parse("cpu,ram,bogus"), frozenset(), "the load figures are always measured")
        self.assertEqual(parse(None), frozenset())


@unittest.skipUnless(ROUTE_DEPS, "install psutil, fastapi and httpx to run the mounted route")
class RealRoute(unittest.TestCase):
    # Temp HERMES_HOME, so nothing here touches the real one.
    def setUp(self):
        if SRC and SRC not in sys.path:
            sys.path.insert(0, SRC)
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        previous = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = home.name
        self.addCleanup(lambda: os.environ.__setitem__("HERMES_HOME", previous) if previous is not None
                        else os.environ.pop("HERMES_HOME", None))

    def get_stats(self, query="", base_url="http://testserver", api=None):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        api = api or load_plugin_api()
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/hermes-vitals-light")
        return TestClient(app, base_url=base_url).get("/api/plugins/hermes-vitals-light/stats" + query).json()

    def wait_stats(self, key, query="", base_url="http://testserver", api=None):
        """Poll until a background refresh has supplied ``key`` (or give up)."""
        api = api or load_plugin_api()
        deadline = time.monotonic() + 20
        while True:
            body = self.get_stats(query, base_url, api)
            if key in body or time.monotonic() > deadline:
                return body
            time.sleep(0.02)

    def test_skip_leaves_the_counts_out(self):
        api = load_plugin_api()
        body = self.get_stats("?skip=clients,processes", api=api)

        self.assertTrue(body["ok"])
        self.assertNotIn("clients", body)
        self.assertNotIn("processes", body)
        self.assertIn("processes", self.wait_stats("processes", "?skip=clients", api=api))

    def test_the_mounted_route_reports_this_machine(self):
        api = load_plugin_api()
        body = self.wait_stats("processes", api=api)

        self.assertTrue(body["ok"])
        self.assertGreater(body["memory"]["total"], 0)
        self.assertTrue(0 <= body["cpu_percent"] <= 100)
        self.assertEqual(body["processes"]["total"], sum(body["processes"]["by_command"].values()))
        if "waited" in body:
            self.assertIsInstance(body["waited"]["seconds"], int)
            self.assertIn(body["waited"]["verdict"], {"ok", "busy", "stuck"})
            self.assertGreaterEqual(body["free"], 0)

    def test_the_route_asks_the_server_it_runs_in_for_the_session_count(self):
        # The test client's server address is the fake status server's: what a real request would carry.
        api = load_plugin_api()
        base_url = None

        with FakeStatus() as status:
            base_url = f"http://127.0.0.1:{status.port}"
            body = self.wait_stats("clients", "?skip=processes", base_url=base_url, api=api)

            self.assertEqual(body["clients"], {"total": 3})
            self.assertEqual(status.hits, 1)
            self.assertNotIn(
                "clients",
                self.get_stats("?skip=clients,processes", base_url=base_url, api=api),
            )


if __name__ == "__main__":
    unittest.main()
