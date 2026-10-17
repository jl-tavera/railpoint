---
name: railpoint
description: Link a Railway service to a custom domain on Namecheap with the railpoint CLI. Use when the user asks to link or point a domain or subdomain at a Railway service ("point api.example.com at my api service"), or to set up a custom domain on Railway whose DNS is on Namecheap.
---

# railpoint

`railpoint link` adds the custom domain on Railway, writes the two DNS records into Namecheap without touching the
rest of the zone, and waits until Railway reports the domain valid and the certificate issued.

## Preconditions

- A Railway **account** token (created at railway.com/account/tokens with workspace "No workspace"), in
  `RAILWAY_TOKEN` or `~/.railpoint/config.json`. Workspace and project tokens fail with `Not Authorized`.
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

Success looks like `{"ok":true,"data":{"domain":…,"zone":…,"created":…,"written":…,"status":"ready","changes":[…]}}`.
Report the domain, whether it was created or already there, and the record changes.

## Finding names

The user's names may not match Railway's. On `TARGET_AMBIGUOUS`, the `message` lists the candidates as
`name (id)`. If exactly one is clearly the one meant, re-run with its id; otherwise show the candidates and ask
which one. `Candidates: none` usually means the token is not an account token.

## Errors

A failure prints `{"ok":false,"error":{"code":…,"message":…,"hint":…}}`. Per `error.code`:

| Code | What to do |
| --- | --- |
| `DNS_CONFLICT` | Show the user the record from `message` that would be replaced. Re-run with `--force` only after they say yes. |
| `TIMEOUT` | The records are written; Railway is still verifying. Re-run later to check. |
| `NAMECHEAP_IP_NOT_WHITELISTED` | Get the IP with `curl https://api.ipify.org` and tell the user to whitelist it in Namecheap. |
| `RAILWAY_ERROR` with `Not Authorized` | An account token is needed (workspace "No workspace"); tell the user to create one. |
| `MISSING_CREDENTIALS` | Tell the user to run `npx railpoint` in a terminal or set the env vars, as above. If it is the public IP that can't be found, set `NAMECHEAP_CLIENT_IP`. |
| anything else | Report `message` and `hint` as they are. |

Don't retry a failure blindly; only an ambiguous name you've resolved is worth an immediate re-run.
