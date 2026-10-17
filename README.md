# railpoint

CLI that links a Railway service to a custom domain on Namecheap — in one command.

Inspired by [doomain](https://github.com/crafter-station/doomain), scoped to just Namecheap + Railway.

## What it does

1. Adds the custom domain to your Railway service.
2. Writes the required DNS records (CNAME / TXT) in Namecheap.
3. Waits for DNS propagation and confirms Railway verifies the domain.

## Usage

```sh
railpoint                                          # interactive wizard
railpoint link app.example.com --project my-app --service my-api    # scripted
```

## Requires

- Railway API token
- Namecheap API key + whitelisted IP
