# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-11-12

Faster backend scans and a lighter TUI child: counting Hermes processes no longer stalls the
server it measures.

### Changed

- **Process scan.** The scan reads the process names first and a candidate's argv second, and asks
  for a parent only when two Hermes processes could be nested, from one table snapshot on Windows
  instead of one parent map rebuilt per process. The first scan after a start drops from 5.4 s to
  22 ms here (30 ms to 3 ms for the scans after it) and no longer holds the GIL on the
  `hermes serve` event loop for seconds. The count is unchanged.
- **TUI child.** The Python child behind the TUI card no longer imports FastAPI (+22.8 MB) or
  `urllib.request` (+4.7 MB): it serves no route, so the router and the `/api/status` opener are
  only built where they are used. The child's working set goes from 56.8 to 32.2 MB here, private
  bytes from 43.2 to 22.5 MB.

### Added

- `npm run footprint`: measures the interpreter, the `dashboard/plugin_api.py` import and the real
  TUI feed child (spawned through `startFeed`) on the machine it runs on, with a self-report
  cross-check. Node builtins only, no new dependency.
- `assets/mockups/`: a reconstruction of the Desktop status bar with the chip's tooltip open and
  the TUI card, embedded in the README.

### Fixed

- A Hermes now folds only into a parent that is itself Hermes, so a `hermes serve` launched from a
  shell counts on its own instead of folding into a distant Hermes ancestor. The rule is written
  down in the code and in the README.
- The README's footprint figures are measured, say which memory figure they report (working set or
  private bytes), and come with the command that reproduces them.

## [0.1.1] - 2026-10-28

Cross-platform server release: Windows and macOS backends now report free RAM and no longer
probe Linux `/proc`.

### Fixed

- macOS and Windows backend servers: `free` now comes from psutil's available RAM instead of the
  Linux-only `/proc/meminfo`, so the chip shows the free-memory figure and the low-memory verdict
  there too. `waited` stays Linux-only and is omitted, as documented.
- The source installer now puts the TUI widget in the real Hermes home on Windows
  (`%LOCALAPPDATA%\hermes\tui-widgets`, not `~/.hermes`) and honours `HERMES_HOME` and
  `HERMES_DATA_DIR_SUFFIX`, like Hermes itself.
- The TUI feed also accepts `PYTHON` when `HERMES_PYTHON` is not set, as Hermes does.

### Changed

- CI now runs the Node and Python suites on Ubuntu, macOS and Windows.

## [0.1.0] - 2026-10-28

First public release.

### Added

- **Desktop chip** in the status bar: CPU, 1-minute load average, free RAM,
  Linux PSI waited time, active sessions (`👥`) and running Hermes processes
  (`⚙`). On a remote gateway it measures the remote box.
- **Health icon**: `pulse` normally, `watch` on a slow poll, `clock` on a
  timeout, `debug-disconnect` when the backend is offline, `plug` when the
  backend half is missing, `warning` for another backend error.
- **Failure handling**: the last reading is kept, dimmed, with its age and the
  reason in a compact tooltip; polls back off up to 30 s and reset on success.
- **Settings ▸ Plugins ▸ Hermes Vitals Light**: one switch per figure, plus a
  refresh period (1, 3, 5, 10, 30 or 60 s; default 3 s). Counts switched off are
  not measured on the server either (`?skip=`).
- **TUI card** docked above the prompt, with `/vitals` to dock/undock, per-figure
  switches, `detail` mode, `/vitals every <s>`, `/vitals reset` and
  `/vitals help`. Options persist in `<HERMES_HOME>/vitals.json`.
- **Backend route** `GET /api/plugins/hermes-vitals-light/stats`, read-only and
  fail-open, cached counts refreshed in the background, and a stateless
  `/proc` read for PSI and free RAM.
- **Catalog metadata**: `requires_hermes: ">=0.22"` and a hidden `/vitals`
  dashboard page, so the web dashboard has a bundle to load beside
  `plugin_api.py` and the backend route mounts without a 404.
- **Install and disclosure**: catalog install steps for the Desktop, backend
  and TUI halves, plus a README section listing every file and network call
  the plugin makes.
