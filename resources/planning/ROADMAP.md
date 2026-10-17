# railpoint — the roadmap

## Context

The repo is a README. The tool it describes links a Railway service to a custom domain on Namecheap: add
the domain on Railway, write the records Railway asks for into Namecheap, wait until Railway says the
domain is verified and its certificate issued. It is [doomain](https://github.com/crafter-station/doomain)
(Vercel × four DNS providers, oclif, Effect, a provider registry, Clerk, self-update, a 22 KB wizard) cut
down to one platform and one registrar, and rebuilt without the machinery four providers needed. What
doomain got right is kept: the Namecheap client's read-merge-write (`setHosts` deletes every record it is
not sent), the planner's rules (TXT is only ever added; a routing record that already points elsewhere is
a conflict, refused unless `--force`), the JSON envelope, the config file, the poll loop.

Outcome: **two specs, five tickets.** Spec A is `link`, in three slices that each do more of the job: A1
adds the domain on Railway and prints the records; A2 writes them; A3 waits. Spec B ships it: the wizard,
then npm. **The first version is A1** — a user can finish the job by hand from what it prints. **Done is
B2**: `npx railpoint`.

## How to use this file

One spec per session, in order. Open its section, change what you want, run `/spec` (it becomes a GitHub
issue on `jl-tavera/railpoint`), then `/issues` (one ticket per slice, with blocking edges), then `/build`
per ticket or `/autopilot` for the queue. Tick the spec off below when its tickets are merged. Where a
spec file and a section here differ, the spec file is current; a claim that turns out wrong is corrected
in place with a date, never deleted.

| Phase | Spec | Issue | Tickets | Merged |
|---|---|---|---|---|
| 0 | A — `link` | — | A1, A2, A3 | — |
| 1 | B — ship | — | B1, B2 | — |

## The spec graph

```
Phase 0   A  link:  A1 add on Railway, print records → A2 write to Namecheap → A3 wait     ← first version (A1)
Phase 1   B  ship:  B1 wizard ∥ B2 npm                                           ◄ A3     ← done (B2)
```

Run order for `/spec`: **A → B.** Tickets: A1 → A2 → A3 (each edits `src/link.ts`), then B1 and B2 in one
wave.

## Cross-cutting decisions (both specs cite these)

- **Stack.** TypeScript, ESM, Node ≥ 24 running `.ts` directly in the repo (`node src/cli.ts`; tsconfig
  `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`,
  `rewriteRelativeImportExtensions`, imports written with `.ts`); `tsc` builds `dist/` only for the npm
  `bin`, because Node will not strip types under `node_modules` (B2). npm, not Bun. `node --test` with
  `globalThis.fetch` stubbed and fixtures captured from real responses, never typed from memory.
  `tsc --noEmit` is the type check. Two dependencies: `@clack/prompts` (prompts, spinner) and
  `fast-xml-parser` (Namecheap answers in XML). Not: `effect`, oclif (`node:util.parseArgs` does it),
  biome, a provider interface, a registry.
- **Shape.** Flat `src/`: `cli.ts` (args, routing, exit code), `link.ts` (the one flow), `railway.ts`,
  `namecheap.ts`, `plan.ts` (existing + desired → create / skip / conflict), `config.ts`, `output.ts`
  (envelope, TTY detection, the error class); `wizard.ts` arrives in B1. A file is added when a second
  caller needs what it holds, not before.
- **From doomain, nearly verbatim**: the Namecheap `request()`, `splitDomain`, `toDnsRecord`,
  `hostParams` and the read-merge-write `setHosts`; the planner's conflict, force and TXT rules;
  `public-ip` (ipify, 2 s timeout); the `{ok, data} | {ok: false, error: {code, message, hint}}` envelope
  and non-TTY ⇒ JSON; the 0600 config file with env winning; the Namecheap error-text mapping; the 5 s
  poll with an injectable clock. **Fixed on the way**: the planner normalised values (lower-case, no
  trailing dot) while the provider compared raw, so an update could silently no-op — one `sameRecord`
  used by both; `EmailType` is read from `getHosts` and sent back on `setHosts` so mail settings survive;
  `IsUsingOurDNS` is checked before any write; every `fetch` carries `AbortSignal.timeout(15_000)`.
- **Credentials.** Environment wins over `~/.railpoint/config.json` (mode 0600; `RAILPOINT_CONFIG_DIR`
  overrides). `RAILWAY_TOKEN`; `NAMECHEAP_API_USER`, `NAMECHEAP_API_KEY`, `NAMECHEAP_USERNAME` (defaults
  to the API user), `NAMECHEAP_CLIENT_IP` (ipify when unset; the IP must be whitelisted at
  namecheap.com → Profile → Tools → API Access, which the `NAMECHEAP_IP_NOT_WHITELISTED` hint says),
  `NAMECHEAP_SANDBOX=1` for `api.sandbox.namecheap.com`. Only the wizard writes the file; `link` reads.
- **The Railway target** is project + environment + service, each by name or id (`--project`,
  `--service`, `--environment` defaulting to `production`), exact match; zero or several hits is
  `TARGET_AMBIGUOUS` listing the candidates with the hint to pass an id. GraphQL at
  `https://backboard.railway.com/graphql/v2`, bearer token; `errors[]` in a 200 is `RAILWAY_ERROR` with
  the first message. A domain already on the service is reused, never re-created, so running `link`
  twice is how you ask for status. The records to write come from the response (`status.dnsRecords[]`
  for routing, `status.verificationToken` for the TXT), never from a constant; a host label or type the
  planner does not know is `UNSUPPORTED_RECORD`, never a guess.
- **Namecheap writes.** The zone is the longest owned domain (`domains.getList`, paged) that is a suffix
  of the requested name; the host is the rest, or `@`. `getHosts` → plan → `setHosts` with the whole
  list, every time (ADR 0001). TXT records are appended, never replaced. A routing record (A, AAAA,
  CNAME, ALIAS, URL) already at that host with another value is `DNS_CONFLICT`: in a TTY, confirm; in
  JSON, fail with the hint `--force`, which replaces that one record. An apex (`@`) routing record is
  written as Namecheap `ALIAS`. TTL 300. Nothing is ever deleted that the tool did not write.
- **Wait.** Poll `customDomain(id, projectId)` every 5 s until every `dnsRecords[].status` is `VALID`
  and `certificateStatus` is `ISSUED`; `--timeout` seconds, default 300, then `TIMEOUT` naming what is
  still pending; `--no-wait` returns after the write. A transient error inside the loop is logged to
  stderr and the loop continues; no retry anywhere else.
- **Output.** `--json`, or a non-TTY stdout, prints one envelope and never prompts. A TTY gets a clack
  spinner per stage and one confirm before the Namecheap write, showing the plan. stdout carries the
  result; everything else goes to stderr. Exit 0 or 1. One `RailpointError {code, message, hint}`; the
  codes: `MISSING_CREDENTIALS`, `NAMECHEAP_AUTH_FAILED`, `NAMECHEAP_IP_NOT_WHITELISTED`,
  `NAMECHEAP_NOT_OUR_DNS`, `ZONE_NOT_FOUND`, `DNS_CONFLICT`, `UNSUPPORTED_RECORD`, `RAILWAY_ERROR`,
  `TARGET_AMBIGUOUS`, `TIMEOUT`.
- **Words** are in [`../reference/glossary.md`](../reference/glossary.md): zone, host record, routing
  record, verification record, target, link. Decisions in [`../reference/adr/`](../reference/adr/);
  0001 is the read-merge-write rule.

---

## Phase 0 — `link`

### Spec A — `railpoint link`: add on Railway, write to Namecheap, wait

**Problem.** Linking a Railway service to a Namecheap domain is four tabs: Railway's settings to add the
domain and copy two records, Namecheap's Advanced DNS to paste them without losing the others, then
refreshing Railway until it turns green. Namecheap's API makes the middle step dangerous (`setHosts`
drops whatever it is not sent), which is why nobody scripts it.

**Slices.**
1. *As the operator, `railpoint link app.example.com --project my-app --service api` adds the domain to
   that service (or finds it already there) and prints the records Namecheap needs, as text, or as JSON
   when piped.* — the scaffold (`package.json`, `tsconfig.json`, `node --test`, the `#!/usr/bin/env node`
   line in `cli.ts`, the checks block in `CLAUDE.md`); `cli.ts` (`parseArgs`, `link` only); `railway.ts`
   (`resolveTarget`, `listCustomDomains`, `customDomainCreate`); `config.ts` with every credential name
   above (the Namecheap ones unused until A2); `output.ts`; `link.ts` down to "here are your records".
   One real `customDomainCreate` response captured into `test/fixtures/railway/` is an acceptance
   criterion: it fixes the TXT host label, which nothing here guesses. Tests: target resolution (exact,
   ambiguous, by id), reuse of an existing domain, the envelope on a non-TTY.
2. *As the operator, the same command writes those records into Namecheap, keeps every record it did
   not touch, and refuses to overwrite a routing record unless I say `--force`.* — `namecheap.ts` (auth
   params, `domains.getList` to find the zone, `dns.getList` for `IsUsingOurDNS`, `getHosts`, `setHosts`
   as POST with `EmailType` and `MXPref` passed back, the error mapping); `plan.ts`; `link.ts` gains the
   plan, the TTY confirm, the write; `config.ts` reads the Namecheap credentials and ipify. Tests on XML
   fixtures: zone found across `getList` pages, the merge keeps unrelated hosts and `EmailType`, TXT
   appends beside an existing TXT, conflict without `--force` is refused and with it replaces one record,
   apex becomes `ALIAS`, not-our-DNS is refused before any write, normalised compare.
3. *As the operator, the command keeps going until Railway says the domain is valid and the certificate
   issued, or tells me what is still pending at the timeout; `--no-wait` skips that.* — `railway.ts`
   gains `customDomainStatus`; `link.ts` the loop with an injectable clock; `--timeout`, `--no-wait`.
   Tests: VALID + ISSUED ends the loop, a pending record at the timeout is `TIMEOUT` naming it, a
   transient error continues.

**Decisions.** Three slices that each extend one command, not three libraries and then a command: every
ticket is demoable. The scaffold rides in A1 because nothing can be demoed before it. `status` is not a
command: `link` is idempotent and re-running it is the status check. No `--dry-run`: the records exist
only after `customDomainCreate`, so a dry run would still change Railway; the TTY confirm shows the plan
before the only destructive step. **Assumed.** One Railway account token with access to the project; one
Namecheap account that holds the zone and uses BasicDNS. **Not building.** `remove`/`unlink` (the tool
never deletes; trigger: the first request); apex and `www` in one call (run it twice); retry/backoff
(trigger: a transient 5xx seen in the wild). **Blocked by.** Nothing; A2 ◄ A1, A3 ◄ A2. **Owns.**
Everything under `src/` and `test/`, `package.json`, `tsconfig.json`, `CLAUDE.md` (the checks block).

---

## Phase 1 — Ship

### Spec B — The wizard and the npm release

**Problem.** After A3 the command works for someone who knows three names and has six environment
variables set. The README promises `railpoint` with no arguments and `npx railpoint`.

**Slices.**
1. *As a first-time user, I run `railpoint` with no arguments, am asked for whatever credential is
   missing, pick the project, environment and service from lists, type the domain, confirm the plan, and
   the link runs; my tokens are saved for next time.* — `wizard.ts` with `@clack/prompts` (`password` for
   secrets, `select` / `autocomplete` over the API's lists, `confirm`); `config.ts` gains `save`;
   `cli.ts` routes no-args to the wizard. The wizard is prompts over the same `link()` A3 left. Test: the
   routing, and that `--json` never reaches the wizard.
2. *As anyone, `npx railpoint` works.* — `package.json` `bin`, `files`, `build` (`tsc` → `dist/`),
   `prepublishOnly`; `tsconfig` `outDir`; `.github/workflows/release.yml` publishing on a GitHub release
   with `npm publish --provenance`; `README.md` quickstart (install, the two credential blocks, one `link`
   line, the wizard) and the records it writes.

**Decisions.** The wizard is a thin prompt layer over `link()`, not a second flow. Publish from CI, not a
laptop. **Assumed.** The npm name `railpoint` is free (`npm view railpoint` before B2; else scope it).
**Not building.** Self-update; `login` / `logout` commands (the wizard saves; deleting
`~/.railpoint/config.json` forgets); a `schema` command for agents (`--json` is the contract).
**Blocked by.** A3; B1 and B2 are independent of each other. **Owns.** B1: `src/wizard.ts`, `src/cli.ts`,
`src/config.ts`, `test/wizard.test.ts`. B2: `package.json`, `tsconfig.json`,
`.github/workflows/release.yml`, `README.md`.

---

## Assumed (strike any)

- Node ≥ 24 on the owner's machine; npm, not Bun (doomain's choice); `node --test`, not mocha.
- One Railway account token, one Namecheap account; the domain uses Namecheap BasicDNS.
- Railway's TXT host label and the routing record's type are whatever A1's captured response says; this
  file names neither.
- Issues on `jl-tavera/railpoint`, label `ready-for-agent`; a tracking issue links the two specs.
- The npm name `railpoint` is available.

## Not building

- A second DNS provider or a second platform, and with them the provider interface, registry,
  multi-account config and cross-provider zone search doomain has (trigger: a second provider is actually
  wanted; then copy doomain's `providers/core/types.ts`).
- `remove`, `point`, `diagnose`, `status`, `--dry-run`, self-update, `schema`, Clerk (triggers in the
  specs above).
- Reading the Railway CLI's linked project from `~/.railway/` (trigger: typing `--project --service`
  gets old).
- Any write to Railway beyond `customDomainCreate`; any deletion in Namecheap.
