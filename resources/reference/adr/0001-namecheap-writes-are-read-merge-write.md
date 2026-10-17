---
status: accepted
---

# Every Namecheap write reads the zone first and sends it back whole

Namecheap's `domains.dns.setHosts` deletes every host record it is not sent, and there is no per-record
endpoint. So the tool never writes blind: `getHosts` → merge the records it wants (append TXTs, replace
one routing record only under `--force`) → `setHosts` with the whole list, `EmailType` and `MXPref`
included so mail settings survive, and `IsUsingOurDNS` checked first because `getHosts` is empty on
foreign nameservers. Trade-off accepted: a record changed in the Namecheap dashboard between the read and
the write is lost; the window is one request, and a lock is not worth it until that bites.
