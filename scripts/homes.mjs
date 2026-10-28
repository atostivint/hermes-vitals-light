// Hermes home resolution, mirroring hermes_constants.get_hermes_home(): an explicit
// HERMES_HOME wins, else the platform data directory (LOCALAPPDATA on Windows, ~/.hermes
// elsewhere), with HERMES_DATA_DIR_SUFFIX applied when Hermes uses one.
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export function hermesHome({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const explicit = env.HERMES_HOME?.trim()

  if (explicit) {
    return explicit
  }

  const suffix = env.HERMES_DATA_DIR_SUFFIX?.trim() || ''
  const join = platform === 'win32' ? win32.join : posix.join

  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local')

    return join(base, `hermes${suffix}`)
  }

  return join(home, `.hermes${suffix}`)
}
