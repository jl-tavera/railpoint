# Specs — the conventions, the posting recipe, and one block per phase

One file per spec, `spec-<letter>-<kebab>.md`, written from the matching section of
[`ROADMAP.md`](../ROADMAP.md) in the form Problem · Solution · Slices (each `(X1)`, `(X2)` …) · Decisions
· Seams under test · Assumed · Not building · Tickets. Each is the body of one GitHub issue; `/issues`
cuts it into one ticket per slice; `/build` builds a ticket; `/autopilot` builds the queue in dependency
order, each ticket in its own worktree. A block per phase is added below when its spec is written.

## Conventions every spec and ticket follows

- **The words are the glossary's** (`../../reference/glossary.md`): zone, host record, routing record,
  verification record, target, link.
- **A retracted claim is corrected in place with a date, never deleted**: `*(Corrected 2026-10-17: …)*`
  inline, or `> ⚠ **Corrected 2026-10-17.** …` as a blockquote.
- **No secret enters a tracked file.** Fixtures captured from real responses have tokens, ids and the
  owner's domains replaced before they are committed.
- **A record is never guessed.** What Namecheap receives is what Railway returned; a shape the planner
  does not know is an error.
- **One owner per file per wave.** Two tickets editing the same file in the same wave would conflict in
  autopilot; such a file is edited in sequence through a blocking edge.

## Posting a spec and building its tickets

```bash
# once: the label /spec and /issues use
gh label list --json name --jq '.[].name' | grep -qx ready-for-agent || \
  gh label create ready-for-agent --color 0E8A16 --description "Agent-buildable spec or ticket"

# one issue per spec, body verbatim from the file
gh issue create --title "Spec A — <title>" \
  --label ready-for-agent --body-file resources/planning/specs/spec-a-<kebab>.md
```

Then `/issues <spec #>`, so a cross-spec blocker (`B1 ◄ A3`) can name a real ticket number; then
`/build <ticket #>` one at a time, or `/autopilot` with the **ticket** numbers listed explicitly (the spec
issues carry the same label and must not be built).
