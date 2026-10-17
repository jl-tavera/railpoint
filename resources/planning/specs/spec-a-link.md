# Spec A — `railpoint link`: add on Railway, write to Namecheap, wait

Phase 0 of the railpoint roadmap (`resources/planning/ROADMAP.md`). Written 2026-10-17 from the roadmap's
Spec A section and its cross-cutting decisions, doomain at `main` (`src/lib/providers/namecheap/index.ts`,
`src/lib/providers/core/planner.ts`, `src/lib/output.ts`, `src/lib/config.ts`, `src/lib/public-ip.ts`,
`src/lib/link-domain.ts`), Railway's public API docs (`customDomainCreate`, `customDomain`) and
Namecheap's (`domains.getList`, `domains.dns.getList`, `getHosts`, `setHosts`). The repo has no code;
this spec creates all of it. Spec B builds on the `link()` this one leaves.

## Problem

Linking a Railway service to a Namecheap domain takes four browser tabs. In Railway you add the domain and
copy two records. In Namecheap's Advanced DNS you paste them without disturbing the records already there.
Then you go back to Railway and refresh until the domain turns green. Scripting the middle step is risky:
`domains.dns.setHosts` deletes every host record it is not sent, and there is no per-record endpoint.
doomain solves this for Vercel, but it does so with a provider registry, Effect, oclif and multi-account
config, and its Namecheap client compares values in a way that can turn an update into a silent no-op.

## Solution

One command, `railpoint link <domain> --project <p> --service <s> [--environment production]`, built up
over three slices. Each slice extends the same command and can be demoed on its own:

- **A1** finds or creates the custom domain on the Railway target and prints the records Railway asks for.
  A user can finish the job by hand from that output.
- **A2** writes those records into the zone at Namecheap. It reads the zone first, merges, and writes
  everything back. A routing record already pointing elsewhere is refused unless `--force`.
- **A3** polls Railway until every record is `VALID` and the certificate is `ISSUED`, or the timeout
  passes.

The output is text with a spinner in a TTY. With `--json`, or when stdout is not a TTY, it is one JSON
envelope. The code is seven flat files and two dependencies. The parts doomain got right are copied
nearly verbatim; four of its gaps are fixed along the way.

## Slices

### 1. As the operator, `railpoint link app.example.com --project my-app --service api` adds the domain to that service (or finds it already there) and prints the records Namecheap needs, as text, or as JSON when piped. (A1)

- **Scaffold.** `package.json`: `"type": "module"`, `engines.node >= 24`, scripts `test` (`node --test`)
  and `typecheck` (`tsc --noEmit`), dependencies `@clack/prompts` and `fast-xml-parser`, devDependencies
  `typescript` and `@types/node`. `tsconfig.json`: `strict`, `module`/`moduleResolution` `nodenext`,
  `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`,
  `rewriteRelativeImportExtensions`, `noEmit`. Every import uses the `.ts` extension. `src/cli.ts` starts
  with `#!/usr/bin/env node`. `.gitignore` covers `node_modules/`, `dist/` and `.env`.
- **`src/output.ts`.**
  - `RailpointError extends Error {code, hint?}`.
  - `isJson(flags)`: true for `--json` or when `!process.stdout.isTTY`.
  - `ok(data)` and `fail(err)`, which print `{ok: true, data}` or
    `{ok: false, error: {code, message, hint}}` to stdout in JSON mode. Otherwise they print text to
    stdout and progress to stderr.
  - An unknown error becomes `INTERNAL` with its message.
- **`src/config.ts`.**
  - `loadCredentials()` reads the environment first, then `~/.railpoint/config.json`
    (`RAILPOINT_CONFIG_DIR` overrides the directory).
  - It returns `{railwayToken, namecheap: {apiUser, apiKey, username, clientIp?, sandbox}}`.
  - A missing value is only an error when a step asks for it: `requireRailway()` and `requireNamecheap()`
    throw `MISSING_CREDENTIALS` naming the variable.
  - A1 calls `requireRailway()` only.
- **`src/railway.ts`.** A `gql(query, variables)` POST to `https://backboard.railway.com/graphql/v2` with
  `Authorization: Bearer` and `AbortSignal.timeout(15_000)`. A non-2xx response, or `errors[]` in a 200,
  is `RAILWAY_ERROR` carrying the first message.
  - `resolveTarget({project, environment, service})`: an exact name match or an id at each level. No
    match, or more than one, is `TARGET_AMBIGUOUS`; the message lists the candidates and the hint is
    "pass the id".
  - `listCustomDomains(target)` returns the domains already on that service.
  - `customDomainCreate(target, domain)`.
  - Both return `{id, domain, records}`. `records` is the routing record(s) from `status.dnsRecords[]`
    plus the verification record built from `status.verificationToken` at the host label the captured
    response shows.
- **`src/link.ts`.** `link(opts, deps)` resolves the target and reuses a domain whose name matches
  case-insensitively, creating one only if none matches. It returns
  `{domain, target, railwayDomainId, records}`. `deps` (fetch, clock, a prompt) is a plain parameter with
  defaults, so tests pass stubs and nothing else is injected.
- **`src/cli.ts`.** `parseArgs` with the `link` subcommand, positional `<domain>`, and the flags
  `--project`, `--service`, `--environment` (default `production`) and `--json`. Anything else prints
  usage and exits 1. It calls `link()`, then `ok`/`fail`, and exits 0 or 1. In a TTY the records print as a
  table: host, type, value.
- **The fixture.** Before the ticket closes, the owner captures one real `customDomainCreate` response
  and one `customDomain` response into `test/fixtures/railway/`, with ids, the token and the domain
  replaced. The verification record's host label and the routing record's type are read from that
  response. A type the code does not know is `UNSUPPORTED_RECORD`.
- **`CLAUDE.md`.** The checks line becomes `npm test` and `npm run typecheck`.

### 2. As the operator, the same command writes those records into Namecheap, keeps every record it did not touch, and refuses to overwrite a routing record unless I say `--force`. (A2)

- **`src/namecheap.ts`.**
  - `request(command, params, method)`: every call carries `ApiUser`, `ApiKey`, `UserName`, `ClientIp`
    and `Command`. The base URL is `https://api.namecheap.com/xml.response`, or `api.sandbox.namecheap.com`
    when `NAMECHEAP_SANDBOX=1`. Parsing uses `fast-xml-parser`, and `Status !== "OK"` throws.
  - Error mapping from the first error's text. "IP" with "whitelist"/"invalid" is
    `NAMECHEAP_IP_NOT_WHITELISTED`, hinted with the IP used and the whitelist page. "API key" or "user" is
    `NAMECHEAP_AUTH_FAILED`. Anything else is `NAMECHEAP_ERROR` with the text.
  - `findZone(name)` pages `namecheap.domains.getList` (100 per page) and returns the longest owned domain
    that is a suffix of `name`, plus the host (`@` at the apex). None found is `ZONE_NOT_FOUND`.
  - `assertOurDns(zone)` calls `namecheap.domains.dns.getList`. `IsUsingOurDNS=false` is
    `NAMECHEAP_NOT_OUR_DNS`, and nothing is written.
  - `getHosts(zone)` returns `{hosts: [{name, type, address, ttl, mxPref}], emailType}`.
  - `setHosts(zone, hosts, emailType)` is a POST form with indexed `HostNameN`, `RecordTypeN`, `AddressN`,
    `TTLN`, `MXPrefN`, and `EmailType`. `IsSuccess !== "true"` throws.
  - The SLD/TLD split takes the first label and the rest (`example.co.uk` → `example` + `co.uk`).
- **`src/plan.ts`.**
  - `sameValue(a, b)` lower-cases and strips a trailing dot. Both the planner and the merge use it, which
    fixes doomain's silent no-op.
  - `plan(existing, desired, {force})` returns `{changes: [{action: create|skip|replace, record}],
    conflicts}`, with these rules:
    - A TXT record with an equal value is skipped; any other TXT is created beside what exists.
    - A routing type (A, AAAA, CNAME, ALIAS, URL, URL301, FRAME) at the same host with an equal value is
      skipped.
    - A routing type at the same host with a different value is a conflict, or `replace` under `--force`.
    - A routing record at `@` is written as `ALIAS`.
    - TTL is 300 on records the tool writes; existing records keep their own.
  - `apply(existing, changes)` returns the full list for `setHosts`. It is pure.
- **`src/link.ts`** gains, after the records are known:
  1. `findZone`, then `assertOurDns`, then `getHosts`, then `plan`.
  2. Conflicts are handled by mode. In a TTY, a clack `confirm` shows the conflicting record and its
     replacement, and a yes means `force`. In JSON mode the run fails with `DNS_CONFLICT`, hint `--force`.
  3. If every change is `skip`, no write happens.
  4. Otherwise `setHosts` runs with `apply(...)` and the `emailType` that was read.
  5. The result gains `zone`, `changes` and `written: boolean`.
- **`src/config.ts`** fills `clientIp` from `https://api.ipify.org` (2 s timeout) when
  `NAMECHEAP_CLIENT_IP` is unset. `username` defaults to `apiUser`.
- **`src/cli.ts`** gains `--force`.

### 3. As the operator, the command keeps going until Railway says the domain is valid and the certificate issued, or tells me what is still pending at the timeout; `--no-wait` skips that. (A3)

- **`src/railway.ts`** gains `customDomainStatus(id, projectId)`, which returns
  `{records: [{hostlabel, requiredValue, currentValue, status}], certificateStatus}`.
- **`src/link.ts`** gains `waitForReady`. It polls every 5 s (`deps.sleep`, `deps.now`) until every
  record status is `VALID` and `certificateStatus` is `ISSUED`.
  - In a TTY the spinner shows the current pending list.
  - An error inside the loop goes to stderr and the loop carries on.
  - At `--timeout` seconds (default 300) it fails with `TIMEOUT`, naming each pending record with
    `currentValue` against `requiredValue`, plus the certificate status. The hint is to re-run `link` later.
  - The result gains `status: "ready"`.
- **`src/cli.ts`** gains `--timeout <s>` and `--no-wait`. With `--no-wait` the result is
  `status: "written"`.

## Decisions

- **Three slices that each extend one command**, rather than three libraries followed by a command. Every
  ticket can be demoed, and the scaffold rides in A1 because nothing can be shown before it. Rung: minimum.
- **No `status` command.** `link` reuses an existing Railway domain and skips records that are already
  equal, so re-running it is the status check. Rung: does not need to exist.
- **No `--dry-run`.** Railway only returns the records after `customDomainCreate`, so a dry run would still
  change Railway. The TTY confirm covers the one step that can lose data. Rung: does not need to exist.
- **The records come from Railway's response, never from a constant.** The host label and routing type are
  fixed by the captured fixture, not by this spec. Rung: never guessed.
- **The whole zone is written back on every write** (ADR 0001), with `EmailType` included. There is no
  lock. Rung: minimum; the lock waits for its trigger.
- **`deps` is a plain parameter with defaults**, not a container. It is what lets the loop and the
  prompts be tested. Rung: one line.
- **The Namecheap code is copied from doomain with Effect removed** (`request`, the domain split, host
  params, read-merge-write). Rung: reused.

## Seams under test

- **A1.** `test/railway.test.ts` stubs `globalThis.fetch`. It covers:
  - `resolveTarget` by name, by id, ambiguous, and not found.
  - A GraphQL `errors[]` in a 200 becoming `RAILWAY_ERROR`.
  - The captured `customDomainCreate` fixture mapped to records.

  `test/link.test.ts` covers an existing domain being reused (no create call) and the JSON envelope's
  shape on success and on failure.
- **A2.** `test/plan.test.ts` (pure, no fetch) covers TXT append, TXT skip-on-equal, a routing conflict,
  `force` replace, apex → `ALIAS`, normalised compare (trailing dot and case), and `apply` keeping every
  untouched host. `test/namecheap.test.ts` uses XML fixtures and covers:
  - `findZone` across two `getList` pages and the longest suffix winning.
  - `IsUsingOurDNS=false` refused before `getHosts`.
  - The `setHosts` form carrying every original host plus `EmailType`.
  - The whitelist error mapped with its hint.

  `test/link.test.ts` covers `DNS_CONFLICT` in JSON mode and no `setHosts` call when everything is skipped.
- **A3.** `test/link.test.ts`, with a fake clock, covers:
  - Pending → `VALID` + `ISSUED` ending the loop.
  - Still pending at the timeout giving `TIMEOUT` with the pending record named.
  - A thrown poll continuing.
  - `--no-wait` making no status call.

## Assumed

- Node ≥ 24 runs `.ts` directly with type stripping and no flag.
- One Railway token reaches the project. One Namecheap account owns the zone, which is on BasicDNS.
- Railway's response carries one routing record per domain, plus the verification token. If it carries
  more, the plan handles each one the same way.
- The owner can capture the two Railway fixtures with a real token during A1.
- A2 runs against the Namecheap sandbox or a throwaway subdomain before a real zone.

## Not building

- `remove` / `unlink` (trigger: the first request; the tool never deletes).
- Apex and `www` in one call (run `link` twice; trigger: a user asks for both).
- Retry or backoff outside the poll loop (trigger: a transient 5xx seen in the wild).
- A lock around read-merge-write (trigger: a record lost to a concurrent dashboard edit).
- Inferring the target from `railway link` state in `~/.railway/` (trigger: typing three flags gets old).
- `status`, `--dry-run`, `point`, `diagnose` (reasons above).

## Tickets (for `/issues`)

| Slice | Blocked by | Owns |
|---|---|---|
| A1 | none | `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `src/{cli,link,railway,config,output}.ts`, `test/{railway,link}.test.ts`, `test/fixtures/railway/`, `CLAUDE.md` (the checks line) |
| A2 | A1 | `src/{namecheap,plan}.ts`, `src/{link,config,cli}.ts`, `test/{namecheap,plan,link}.test.ts`, `test/fixtures/namecheap/` |
| A3 | A2 | `src/{railway,link,cli}.ts`, `test/link.test.ts` |
