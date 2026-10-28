// Dashboard wiring: the manifest has to point at a real backend and a real bundle,
// and every half has to agree on the plugin name and version.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('dashboard/manifest.json', root), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const pluginYaml = readFileSync(new URL('plugin.yaml', root), 'utf8')
const yamlValue = key => pluginYaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].replace(/^["']|["']$/g, '')

test('the dashboard manifest points at files that exist', () => {
  assert.equal(manifest.name, 'hermes-vitals-light')
  assert.equal(manifest.name, yamlValue('name'))
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.version, yamlValue('version'))
  assert.equal(yamlValue('requires_hermes'), '>=0.22')
  assert.ok(existsSync(new URL(`dashboard/${manifest.entry}`, root)), `missing dashboard/${manifest.entry}`)
  assert.ok(existsSync(new URL(`dashboard/${manifest.api}`, root)), `missing dashboard/${manifest.api}`)
})

test('the dashboard bundle registers the manifest component', () => {
  const registered = []
  const window = {
    __HERMES_PLUGIN_SDK__: { React: { createElement: () => null } },
    __HERMES_PLUGINS__: { register: (name, component) => registered.push({ name, component }) }
  }

  vm.runInNewContext(readFileSync(new URL(`dashboard/${manifest.entry}`, root), 'utf8'), { window })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, manifest.name)
  assert.equal(typeof registered[0].component, 'function')
})
