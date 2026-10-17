import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, saveCredentials } from '../src/config.ts'

beforeEach(() => {
  mock.restoreAll()
  for (const k of ['RAILWAY_TOKEN', 'NAMECHEAP_API_USER', 'NAMECHEAP_API_KEY', 'NAMECHEAP_USERNAME', 'NAMECHEAP_CLIENT_IP', 'NAMECHEAP_SANDBOX']) delete process.env[k]
  process.env.RAILPOINT_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), 'railpoint-')), 'nested')
})

const saved = () => JSON.parse(readFileSync(configPath(), 'utf8'))

test('saveCredentials merges into the existing file and keeps it owner-only', () => {
  saveCredentials({ railwayToken: 'tok', namecheap: { apiUser: 'user', sandbox: true } })
  writeFileSync(configPath(), JSON.stringify({ ...saved(), other: 1 }), { mode: 0o644 })
  saveCredentials({ railwayToken: undefined, namecheap: { apiKey: 'key', apiUser: undefined } })
  assert.deepEqual(saved(), { railwayToken: 'tok', other: 1, namecheap: { apiUser: 'user', sandbox: true, apiKey: 'key' } })
  if (process.platform !== 'win32') {
    assert.equal(statSync(configPath()).mode & 0o777, 0o600)
    assert.equal(statSync(process.env.RAILPOINT_CONFIG_DIR!).mode & 0o777, 0o700)
  }
})
