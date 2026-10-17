import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RailpointError } from './output.ts'

export type Credentials = {
  railwayToken?: string
  namecheap: { apiUser?: string; apiKey?: string; username?: string; clientIp?: string; sandbox: boolean }
}

export type NamecheapAuth = { apiUser: string; apiKey: string; username: string; clientIp: string; sandbox: boolean }

export const configPath = () => join(process.env.RAILPOINT_CONFIG_DIR ?? join(homedir(), '.railpoint'), 'config.json')

// The environment wins over ~/.railpoint/config.json, value by value.
export function loadCredentials(): Credentials {
  const env = process.env
  let file: Partial<Credentials> = {}
  try {
    file = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new RailpointError('INTERNAL', `Cannot read ${configPath()}: ${(e as Error).message}`)
  }
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
