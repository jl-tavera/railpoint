export class RailpointError extends Error {
  code: string
  hint?: string

  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'RailpointError'
    this.code = code
    this.hint = hint
  }
}

export function isJson(flags: { json?: boolean }): boolean {
  return Boolean(flags.json) || !process.stdout.isTTY
}

export function ok(data: unknown, json: boolean, text: () => string): void {
  process.stdout.write(json ? JSON.stringify({ ok: true, data }) + '\n' : text() + '\n')
}

export function fail(err: unknown, json: boolean): void {
  const e = err instanceof RailpointError ? err : new RailpointError('INTERNAL', err instanceof Error ? err.message : String(err))
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, hint: e.hint ?? null } }) + '\n')
  else process.stderr.write(`error ${e.code}: ${e.message}\n` + (e.hint ? `hint: ${e.hint}\n` : ''))
}

// RAILPOINT_DEBUG=1: every API request and raw response, on stderr so stdout stays the one JSON line.
export function debug(label: string, text: string): void {
  if (process.env.RAILPOINT_DEBUG === '1') process.stderr.write(`[railpoint] ${label} ${text}\n`)
}
