import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CANCEL_SYMBOL } from '@clack/prompts'
import { main } from '../src/cli.ts'
import { configPath, saveCredentials } from '../src/config.ts'
import { runWizard, type Prompts } from '../src/wizard.ts'
import { stubFetch } from './stub.ts'

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

const node = (id: string, name: string, envs: string[], services: string[]) => ({
  node: { id, name, environments: { edges: envs.map((e) => ({ node: { id: `${id}-${e}`, name: e } })) }, services: { edges: services.map((v) => ({ node: { id: `${id}-${v}`, name: v } })) } },
})
const projects = { data: { me: { workspaces: [{ projects: { edges: [node('p1', 'blog', ['production'], ['web']), node('p2', 'my-app', ['staging', 'production'], ['api', 'worker'])] } }] } } }

// Answers each prompt from the script in order; a select answer is an option label. Records what was asked.
function prompts(...answers: (string | symbol)[]) {
  const asked: { kind: string; message: string; initialValue?: string; options?: string[] }[] = []
  const next = () => answers.length ? answers.shift()! : assert.fail(`unexpected prompt: ${asked.at(-1)?.message}`)
  const p = {
    intro: () => {},
    cancel: () => {},
    password: async (o: { message: string }) => (asked.push({ kind: 'password', message: o.message }), next()),
    text: async (o: { message: string; initialValue?: string }) => (asked.push({ kind: 'text', message: o.message, initialValue: o.initialValue }), next()),
    select: async (o: { message: string; options: { label?: string; value: unknown }[] }) => {
      asked.push({ kind: 'select', message: o.message, options: o.options.map((x) => x.label!) })
      const a = next()
      return typeof a === 'symbol' ? a : o.options.find((x) => x.label === a)!.value
    },
  }
  return { asked, prompts: p as unknown as Prompts }
}

test('missing credentials are asked, saved, and the chosen ids come back as link options', async () => {
  const calls = stubFetch('198.51.100.9\n', projects)
  const { asked, prompts: p } = prompts('tok', 'user', 'key', '198.51.100.9', 'my-app', 'production', 'api', 'app.example.com')
  const opts = await runWizard(p)
  assert.deepEqual(asked.map((a) => a.kind), ['password', 'password', 'password', 'text', 'select', 'select', 'select', 'text'])
  assert.equal(asked[3].initialValue, '198.51.100.9')
  assert.deepEqual(asked[5].options, ['production', 'staging'])
  assert.deepEqual(saved(), { railwayToken: 'tok', namecheap: { apiUser: 'user', apiKey: 'key', clientIp: '198.51.100.9' } })
  assert.equal(calls[1].auth, 'Bearer tok')
  assert.deepEqual(opts, {
    domain: 'app.example.com', project: 'p2', environment: 'p2-production', service: 'p2-api', token: 'tok',
    namecheap: { apiUser: 'user', apiKey: 'key', username: 'user', clientIp: '198.51.100.9', sandbox: false },
    force: false, wait: true, timeout: 300,
  })
})

test('credentials already present are not asked, and nothing is saved', async () => {
  Object.assign(process.env, { RAILWAY_TOKEN: 'tok', NAMECHEAP_API_USER: 'user', NAMECHEAP_API_KEY: 'key', NAMECHEAP_CLIENT_IP: '203.0.113.7' })
  stubFetch(projects)
  const { asked, prompts: p } = prompts('blog', 'production', 'web', 'blog.example.com')
  const opts = await runWizard(p)
  assert.deepEqual(asked.map((a) => a.kind), ['select', 'select', 'select', 'text'])
  assert.equal(opts?.service, 'p1-web')
  assert.throws(() => saved(), { code: 'ENOENT' })
})

test('a cancel returns nothing, saves nothing and calls no API', async () => {
  const calls = stubFetch()
  const { prompts: p } = prompts(CANCEL_SYMBOL)
  assert.equal(await runWizard(p), undefined)
  assert.equal(calls.length, 0)
  assert.throws(() => saved(), { code: 'ENOENT' })
})

// Runs the CLI as if stdin and stdout were (or were not) a terminal, capturing stderr.
async function cli(argv: string[], tty: boolean, p?: Prompts) {
  const err: string[] = []
  const was = [process.stdin.isTTY, process.stdout.isTTY]
  process.stdin.isTTY = process.stdout.isTTY = tty
  const write = mock.method(process.stderr, 'write', (chunk: string) => (err.push(chunk), true))
  const code = await main(argv, { prompts: p }).finally(() => {
    write.mock.restore()
    ;[process.stdin.isTTY, process.stdout.isTTY] = was
  })
  return { code, stderr: err.join('') }
}

test('no arguments in a terminal runs the wizard; a cancel there exits 0', async () => {
  const { asked, prompts: p } = prompts(CANCEL_SYMBOL)
  const { code } = await cli([], true, p)
  assert.equal(code, 0)
  assert.equal(asked[0].message, 'Railway API token')
})

for (const [argv, tty] of [[['--json'], true], [[], false]] as const) {
  test(`no command with ${tty ? '--json' : 'no terminal'} prints usage and exits 1`, async () => {
    const { asked, prompts: p } = prompts()
    const { code, stderr } = await cli([...argv], tty, p)
    assert.equal(code, 1)
    assert.match(stderr, /^usage: railpoint/)
    assert.equal(asked.length, 0)
  })
}
