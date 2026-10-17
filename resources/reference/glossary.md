# railpoint

A CLI that links a Railway service to a custom domain on Namecheap.

## Language

**Zone**: the domain Namecheap holds the records for (`example.com`), found as the longest owned domain
that is a suffix of the name being linked. _Avoid_: domain (ambiguous with the name being linked), SLD/TLD
(Namecheap's API parameters, not our word).

**Host record**: one row of a zone's DNS at Namecheap — host, type, value, TTL (and `MXPref` for MX).
`setHosts` replaces all of them at once. _Avoid_: DNS entry, host.

**Routing record**: the record that sends traffic to Railway — a `CNAME` on a subdomain, an `ALIAS` on
the apex — with the value Railway returns in `status.dnsRecords[]`. _Avoid_: the CNAME (not always one).

**Verification record**: the `TXT` Railway asks for, carrying `status.verificationToken`, at the host
label Railway names. Appended beside existing TXTs, never replacing one.

**Target**: the Railway service a domain is linked to, named as project + environment + service.
_Avoid_: app, deployment.

**Link**: the whole act — add the domain to the target on Railway, write the routing and verification
records into the zone, wait until Railway reports every record `VALID` and the certificate `ISSUED`.
Idempotent: a second run finds what exists and reports. _Avoid_: connect, attach, point.
