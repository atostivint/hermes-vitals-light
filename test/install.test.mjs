// Install paths: the source installer must pick the same Hermes home as the platform
// runtime, especially on Windows where it is %LOCALAPPDATA%\hermes, not ~/.hermes.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hermesHome } from '../scripts/homes.mjs'

test('Windows uses LOCALAPPDATA; macOS and Linux use ~/.hermes', () => {
  assert.equal(
    hermesHome({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u', platform: 'win32' }),
    'C:\\Users\\u\\AppData\\Local\\hermes'
  )
  assert.equal(hermesHome({ env: {}, home: '/Users/u', platform: 'darwin' }), '/Users/u/.hermes')
  assert.equal(hermesHome({ env: {}, home: '/home/u', platform: 'linux' }), '/home/u/.hermes')
})

test('an explicit HERMES_HOME wins on every platform', () => {
  assert.equal(
    hermesHome({ env: { HERMES_HOME: '/custom/home' }, home: '/Users/u', platform: 'darwin' }),
    '/custom/home'
  )
  assert.equal(
    hermesHome({ env: { HERMES_HOME: 'D:\\hermes' }, home: 'C:\\Users\\u', platform: 'win32' }),
    'D:\\hermes'
  )
})

test('a Windows user without LOCALAPPDATA falls back under their home', () => {
  assert.equal(
    hermesHome({ env: {}, home: 'C:\\Users\\u', platform: 'win32' }),
    'C:\\Users\\u\\AppData\\Local\\hermes'
  )
})

test('HERMES_DATA_DIR_SUFFIX is part of the default home, as in Hermes', () => {
  assert.equal(
    hermesHome({ env: { HERMES_DATA_DIR_SUFFIX: '-work' }, home: '/home/u', platform: 'linux' }),
    '/home/u/.hermes-work'
  )
  assert.equal(
    hermesHome({
      env: { HERMES_DATA_DIR_SUFFIX: '-work', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      home: 'C:\\Users\\u',
      platform: 'win32'
    }),
    'C:\\Users\\u\\AppData\\Local\\hermes-work'
  )
})
