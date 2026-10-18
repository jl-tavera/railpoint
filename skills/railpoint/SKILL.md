---
name: railpoint
description: Link a Railway service to a custom domain on Namecheap with the railpoint CLI. Use when the user asks to link or point a domain or subdomain at a Railway service ("point api.example.com at my api service"), or to set up a custom domain on Railway whose DNS is on Namecheap.
---

# railpoint

`railpoint link` adds the custom domain on Railway, writes the two DNS records into Namecheap without touching the
rest of the zone, and waits until Railway reports the domain valid and the certificate issued.

## Preconditions

- A Railway account or workspace token (created at railway.com/account/tokens), in `RAILWAY_TOKEN` or
  `~/.railpoint/config.json`. Project tokens fail with `Not Authorized`.
- The Namecheap API turned on, with `NAMECHEAP_API_USER` and `NAMECHEAP_API_KEY` set or saved in the config, and this
  machine's public IP whitelisted (Profile → Tools → Namecheap API Access).

**Never ask for a token or API key in the chat.** If credentials are missing, tell the user to run `npx railpoint`
once in their own terminal (the wizard saves them to `~/.railpoint/config.json`), or to export the env vars.

## The command

```sh
npx -y railpoint link <domain> --project <name|id> --service <name|id> [--environment <name|id>] --json
```

- One run per domain or subdomain. `--environment` defaults to `production`.
- It prints one JSON line and exits 0 or 1 (a bad flag prints usage to stderr instead, with no JSON). It can wait up to 5 minutes (`--timeout <s>` to change).
- Re-running is safe: whatever is in place is skipped, so a re-run is also the status check.

No Railway service yet, but a GitHub repo? `create` makes the project and the service (both named after the repo
unless `--project`/`--service` say otherwise; existing ones are reused), then links the same way:

```sh
npx -y railpoint create <domain> --repo <owner/name> [--project <name|id>] [--service <name>] [--branch <b>] --json
```

Its JSON adds `projectCreated` and `serviceCreated`. A `RAILWAY_ERROR` naming the repo means Railway's GitHub app
can't reach it; tell the user to grant it access.

Success looks like `{"ok":true,"data":{"domain":…,"zone":…,"created":…,"written":…,"status":"ready","changes":[…]}}`.
Report the domain, whether it was created or already there, and the record changes.

## Finding names

The user's names may not match Railway's. On `TARGET_AMBIGUOUS`, the `message` lists the candidates as
`name (id)`. If exactly one is clearly the one meant, re-run with its id; otherwise show the candidates and ask
which one. `Candidates: none` usually means the token can't see that project (a workspace token sees only its workspace).

## Errors

A failure prints `{"ok":false,"error":{"code":…,"message":…,"hint":…}}`. Per `error.code`:

| Code | What to do |
| --- | --- |
| `DNS_CONFLICT` | Show the user the record from `message` that would be replaced. Re-run with `--force` only after they say yes. |
| `INVALID_DOMAIN` | The domain isn't a hostname. Ask the user for the exact name, like `app.example.com`. |
| `TIMEOUT` | The records are written; Railway is still verifying. Re-run later to check. |
| `NAMECHEAP_IP_NOT_WHITELISTED` | Get the IP with `curl https://api.ipify.org` and tell the user to whitelist it in Namecheap. |
| `RAILWAY_ERROR` with `Not Authorized` | The token is a project token or revoked; tell the user to create an account or workspace token. |
| `MISSING_CREDENTIALS` | Tell the user to run `npx railpoint` in a terminal or set the env vars, as above. If it is the public IP that can't be found, set `NAMECHEAP_CLIENT_IP`. |
| anything else | Report `message` and `hint` as they are. |

Don't retry a failure blindly; only an ambiguous name you've resolved is worth an immediate re-run.
