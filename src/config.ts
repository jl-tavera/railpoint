import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { RailpointError } from './output.ts'

export type Credentials = {
  railwayToken?: string
  namecheap: { apiUser?: string; apiKey?: string; username?: string; clientIp?: string; sandbox: boolean }
}

export type NamecheapAuth = { apiUser: string; apiKey: string; username: string; clientIp: string; sandbox: boolean }

export const configPath = () => join(process.env.RAILPOINT_CONFIG_DIR ?? join(homedir(), '.railpoint'), 'config.json')

type ConfigFile = { railwayToken?: string; namecheap?: Partial<Credentials['namecheap']> }

export function readConfig(): ConfigFile {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new RailpointError('INTERNAL', `Cannot read ${configPath()}: ${(e as Error).message}`)
    return {}
  }
}

// Unset values are left out, so they never overwrite what the file already has.
const defined = (o: object = {}) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

// Merges into the config file, which holds secrets: the file is 0600 and its directory 0700.
export function saveCredentials(partial: ConfigFile): void {
  const file = readConfig()
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify({ ...file, ...defined(partial), namecheap: { ...file.namecheap, ...defined(partial.namecheap) } }, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600) // `mode` only applies when the file is created
}

// The environment wins over ~/.railpoint/config.json (or `file`, its contents as the wizard has them), value by value.
export function loadCredentials(file: ConfigFile = readConfig()): Credentials {
  const env = process.env
  const namecheap = file.namecheap ?? { sandbox: false }
  const apiUser = env.NAMECHEAP_API_USER || namecheap.apiUser
  return {
    railwayToken: env.RAILWAY_TOKEN || file.railwayToken,
    namecheap: {
      apiUser,
      apiKey: env.NAMECHEAP_API_KEY || namecheap.apiKey,
      username: env.NAMECHEAP_USERNAME || namecheap.username || apiUser,
      clientIp: env.NAMECHEAP_CLIENT_IP || namecheap.clientIp,
      sandbox: env.NAMECHEAP_SANDBOX ? env.NAMECHEAP_SANDBOX === '1' : Boolean(namecheap.sandbox),
    },
  }
}

export function requireRailway(creds: Credentials): string {
  if (!creds.railwayToken) throw new RailpointError('MISSING_CREDENTIALS', 'RAILWAY_TOKEN is not set', `export RAILWAY_TOKEN, or put railwayToken in ${configPath()}`)
  return creds.railwayToken
}

// This machine's public IP from api.ipify.org, or '' when it cannot be found.
export const publicIp = () => fetch('https://api.ipify.org', { signal: AbortSignal.timeout(2_000) })
  .then((r) => (r.ok ? r.text() : ''), () => '')
  .then((t) => t.trim())

// The client IP Namecheap checks against its whitelist: NAMECHEAP_CLIENT_IP, else this machine's public IP.
export async function requireNamecheap(creds: Credentials): Promise<NamecheapAuth> {
  const { apiUser, apiKey, username, clientIp, sandbox } = creds.namecheap
  for (const [name, value] of [['NAMECHEAP_API_USER', apiUser], ['NAMECHEAP_API_KEY', apiKey]]) {
    if (!value) throw new RailpointError('MISSING_CREDENTIALS', `${name} is not set`, `export ${name}, or put namecheap in ${configPath()}`)
  }
  const ip = clientIp || await publicIp()
  if (!ip) throw new RailpointError('MISSING_CREDENTIALS', 'Could not find this machine\'s public IP from api.ipify.org', 'export NAMECHEAP_CLIENT_IP with the IP whitelisted at Namecheap')
  return { apiUser: apiUser!, apiKey: apiKey!, username: username!, clientIp: ip, sandbox }
}
