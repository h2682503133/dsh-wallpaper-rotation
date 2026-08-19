// Package-contract smoke test: validates that the published artifact keeps the
// shapes the DSH plugin loader depends on (dsh.bundle.patch, dsh.client,
// exports["./client"], main entry, files list).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('package.json declares the bundle patch', () => {
  assert.ok(pkg.dsh?.bundle?.patch, 'dsh.bundle.patch missing')
  assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), 'patch file missing')
})

test('package.json declares the web client', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh?.client?.inject), 'client inject must be an array')
})

test('exports["./client"] points at a real file', () => {
  const client = pkg.exports?.['./client']
  assert.ok(typeof client === 'string', 'exports["./client"] must be a string')
  assert.ok(existsSync(join(root, client)), `client bundle missing: ${client}`)
})

test('main entry exists', () => {
  assert.ok(existsSync(join(root, pkg.main)), `main missing: ${pkg.main}`)
})

test('files list covers every shipped path', () => {
  for (const entry of pkg.files ?? []) {
    assert.ok(existsSync(join(root, entry)), `files entry missing: ${entry}`)
  }
})
