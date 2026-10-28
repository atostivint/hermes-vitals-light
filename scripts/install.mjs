// Installs the built halves of this machine:
// - Desktop: desktop/plugin.js -> <hermes home>/desktop-plugins/hermes-vitals-light/plugin.js
// - TUI:     tui/hermes-vitals-light.mjs -> <hermes home>/tui-widgets/hermes-vitals-light.mjs
// Usage: node scripts/install.mjs [--desktop | --tui] [hermesHome]   (both by default)
// Home resolution mirrors hermes_constants.get_hermes_home(): $HERMES_HOME, else
// %LOCALAPPDATA%\hermes on Windows, else ~/.hermes (macOS and Linux).
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hermesHome } from './homes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const only = args.find(arg => arg === '--desktop' || arg === '--tui')
const home = args.find(arg => !arg.startsWith('--')) || hermesHome()

function install(from, dir, name) {
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(root, from), join(dir, name))
  console.log(`installed -> ${join(dir, name)}`)
}

if (only !== '--tui') {
  install('desktop/plugin.js', join(home, 'desktop-plugins', 'hermes-vitals-light'), 'plugin.js')
}

if (only !== '--desktop') {
  install('tui/hermes-vitals-light.mjs', join(home, 'tui-widgets'), 'hermes-vitals-light.mjs')
}
