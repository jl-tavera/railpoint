# Spec B — The wizard and the npm release

Phase 1 of the railpoint roadmap (`resources/planning/ROADMAP.md`). Written 2026-10-17 from the roadmap's
Spec B section and Spec A as specified. If A3 merges with a different `link()` signature or config shape,
this spec gets a dated `> ⚠ Corrected` block before `/spec` posts it.

## Problem

After A3, `railpoint link` works for someone who already knows the project, environment and service names
and has six environment variables set. The README promises two more things: `railpoint` with no arguments
as a guided flow, and `npx railpoint`. Neither exists yet. Node will not strip types from `.ts` files under
`node_modules`, so the source cannot be published as it is.

## Solution

`railpoint` with no arguments starts a clack wizard. It asks only for the credentials that are missing and
saves them. It lists the projects, environments and services the token can see and asks for the domain.
Then it calls the same `link()` as the command, so the plan, the confirm and the wait are the ones Spec A
built. Separately, `tsc` builds `dist/` for the npm `bin`, and a GitHub release publishes it with
provenance. The README gains a quickstart.

## Slices

### 1. As a first-time user, I run `railpoint` with no arguments, am asked for whatever credential is missing, pick the project, environment and service from lists, type the domain, confirm the plan, and the link runs; my tokens are saved for next time. (B1)

- **`src/wizard.ts`.** `runWizard(deps)` uses `@clack/prompts`:
  1. `intro`.
  2. A `password` prompt for each missing credential (`RAILWAY_TOKEN`, then the Namecheap API user, key
     and client IP, the IP pre-filled from ipify).
  3. `select` over projects, then environments (`production` first), then services. `railway.ts` gains
     `listProjects()`, which returns projects with their environments and services in one query.
  4. `text` for the domain, validated as a hostname.
  5. `link()` with the chosen ids.
  6. `outro` with the result.

  A cancel at any prompt exits 0 with "cancelled". The ids, not the names, go to `link()`, so
  `TARGET_AMBIGUOUS` cannot happen here.
- **`src/config.ts`** gains `saveCredentials(partial)`. It merges into `~/.railpoint/config.json`, writes
  with mode `0o600`, and creates the directory with `0o700`. The wizard saves after the credential prompts
  and before `link()`, so a failed link does not lose what was typed.
- **`src/cli.ts`.** No arguments in a TTY runs the wizard. No arguments outside a TTY, or with `--json`,
  prints usage and exits 1; the wizard never runs headless.

### 2. As anyone, `npx railpoint` works. (B2)

- **`package.json`.** `bin: {"railpoint": "dist/cli.js"}`, `files: ["dist"]`, scripts `build`
  (`tsc -p tsconfig.build.json`) and `prepublishOnly` (`npm test && npm run build`), plus `repository`,
  `license: MIT` and `keywords`.
- **`tsconfig.build.json`** extends `tsconfig.json` with `noEmit: false`, `outDir: dist`,
  `rootDir: src`, and excludes `test`. `rewriteRelativeImportExtensions` turns `.ts` imports into `.js`.
  The shebang survives.
- **`.github/workflows/release.yml`** runs on `release: published`. Its steps are checkout, setup-node 24
  with the npm registry, `npm ci`, `npm test`, `npm run build`, and `npm publish --provenance --access
  public`, with `NPM_TOKEN` from repository secrets and `permissions: id-token: write`.
- **`LICENSE`** (MIT).
- **`README.md`.**
  - The quickstart: `npx railpoint` for the wizard, or the env block plus one `link` line.
  - The Namecheap whitelist step.
  - What gets written (one routing record, one TXT) and what is never touched.
  - The JSON envelope for scripts.
  - The credit to doomain stays.

## Decisions

- **The wizard is a prompt layer over `link()`, not a second flow.** doomain's wizard is 22 KB because it
  re-implements its link; this one only collects arguments. Rung: reused.
- **The wizard passes ids, never names.** The lists come from the API, so there is nothing to disambiguate.
  Rung: minimum.
- **A separate `tsconfig.build.json`.** The repo keeps `noEmit` and running `.ts` directly, and the build
  config is the one place `dist/` exists. Rung: minimum.
- **Publish from CI on a GitHub release**, with provenance, not from a laptop. Rung: native platform
  feature.

## Seams under test

- **B1.** `test/wizard.test.ts` covers:
  - The CLI routing: no arguments with a TTY goes to the wizard; no arguments with `--json` or no TTY
    gives usage and exit 1.
  - `runWizard` with stubbed prompts and `fetch`: missing credentials are asked and saved before `link()`;
    present credentials are not asked; a cancel exits 0 and does not call `link()`.
  - `saveCredentials` merging into an existing file and writing mode `0o600`, checked on POSIX only.
- **B2.** No test file. Done-when: `npm run build && npm pack --dry-run` lists only `dist/`,
  `package.json`, `README.md` and `LICENSE`; `node dist/cli.js --help` prints usage; and after the first
  release, `npx railpoint@latest --help` does the same.

## Assumed

- The npm name `railpoint` is free (`npm view railpoint` before B2; otherwise `@jl-tavera/railpoint`, and
  the README follows).
- The owner adds `NPM_TOKEN` to the repository secrets before the first release.
- Railway's `projects` query returns environments and services nested, so the wizard needs one call. If it
  does not, it makes one call per level.

## Not building

- Self-update (trigger: users on stale versions file bugs that are already fixed).
- `login` / `logout` commands (the wizard saves credentials; deleting the config file forgets them).
- A `schema` command for agents (`--json` is the contract).
- Choosing the Namecheap zone in the wizard (the zone follows from the domain typed).
- A changelog generator or semantic-release (trigger: more than one release a month).

## Tickets (for `/issues`)

| Slice | Blocked by | Owns |
|---|---|---|
| B1 | A3 | `src/wizard.ts`, `src/{cli,config,railway}.ts`, `test/wizard.test.ts` |
| B2 | A3 | `package.json`, `package-lock.json`, `tsconfig.build.json`, `.github/workflows/release.yml`, `LICENSE`, `README.md` |
