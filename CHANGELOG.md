# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
