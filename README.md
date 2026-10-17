# railpoint

CLI that links a Railway service to a custom domain on Namecheap — in one command.

Inspired by [doomain](https://github.com/crafter-station/doomain), scoped to just Namecheap + Railway.

## Quickstart

You need Node 24.2 or later, a [Railway API token](https://railway.com/account/tokens), and a domain on
Namecheap that uses Namecheap BasicDNS.

1. **Turn on the Namecheap API and whitelist your IP.** In Namecheap, go to Profile → Tools → Namecheap API
   Access, turn the API on, copy the API key, and add this machine's public IP (`curl https://api.ipify.org`)
   under Whitelisted IPs. Namecheap rejects calls from any other IP.
2. **Run the wizard.**

   ```sh
   npx railpoint
   ```

   It asks for whichever credentials are missing and saves them to `~/.railpoint/config.json` (mode 0600).
   Pick the project, environment and service from the lists and type the domain. It writes the records and
   waits until Railway reports the domain valid and the certificate issued.

Or, for scripts and CI, set the environment and run `link`:

```sh
export RAILWAY_TOKEN=...
export NAMECHEAP_API_USER=...
export NAMECHEAP_API_KEY=...
# optional: NAMECHEAP_USERNAME (defaults to the API user), NAMECHEAP_CLIENT_IP (defaults to
# this machine's public IP), NAMECHEAP_SANDBOX=1

npx railpoint link app.example.com --project my-app --service my-api
```

`--environment` defaults to `production`. `--no-wait` returns once the records are written, `--timeout <s>`
bounds the wait (default 300), and `--force` replaces a routing record that points elsewhere. Re-running is
safe: what is already in place is skipped, so a second run is the status check.

## What it writes

1. The custom domain on your Railway service.
2. In the Namecheap zone, the two records Railway asks for:
   - one routing record — a CNAME, or an ALIAS at the zone apex;
   - one TXT record, Railway's verification.

Nothing else is touched. Every other host record is read and written back as it was, along with the zone's
email setting. If a routing record at that host already points elsewhere, railpoint asks first (or needs
`--force`), then replaces the routing records at that host. A zone that does not use Namecheap BasicDNS is refused, not changed.

## For scripts

With `--json`, or whenever stdout is not a terminal, railpoint prints one JSON line and exits 0 or 1:

```json
{"ok":true,"data":{"domain":"app.example.com","zone":"example.com","created":true,"written":true,"status":"ready","changes":[...]}}
{"ok":false,"error":{"code":"DNS_CONFLICT","message":"A routing record already points elsewhere: ...","hint":"pass --force to replace it"}}
```

`error.code` is one of `MISSING_CREDENTIALS`, `NAMECHEAP_IP_NOT_WHITELISTED`, `NAMECHEAP_AUTH_FAILED`,
`NAMECHEAP_NOT_OUR_DNS`, `ZONE_NOT_FOUND`, `DNS_CONFLICT`, `TARGET_AMBIGUOUS`, `UNSUPPORTED_RECORD`,
`TIMEOUT`, `RAILWAY_ERROR`, `NAMECHEAP_ERROR` or `INTERNAL`. The wizard never runs headless: `railpoint`
with no arguments outside a terminal prints usage and exits 1.

## License

MIT
