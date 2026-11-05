# Moving a household

A household moves with its archive ([household-archive.md](household-archive.md)).
What decides whether the members and guests notice is not the data, which
always travels, but **the address**: every app knows a household by the URL it
paired, and keeps its members' sessions under that pairing.

## Keep the name: repoint it

When the household has a name of its own (`maison.dupont.fr`), keep it.

1. Export from the console (section 07): that archive keeps the sessions,
   the PINs, `secret.key` and the push tokens.
2. Import it on the new machine (`scripts/import-household.sh`,
   `scripts/container.sh import`, or `ops/household.sh add … --from`).
3. Point the name's A record (or CNAME, or tunnel) at the new machine. Caddy
   takes a certificate as soon as the name resolves there.

Nothing changes for anyone: no device is paired again, no code is handed out,
guests in other households do not see it happen. This is the way to move.

## Change the name: leave a forwarding record

When the name changes — a new domain, or leaving `<name>.chezmaurice.eu` —
publish one TXT record under the **old** name, and keep it for as long as
devices may still come back to it (six months is a fair floor):

```
_maurice.maison.dupont.fr.  TXT  "v=maurice1; moved=https://foyer.dupont.eu"
```

- `v=maurice1` is required; `moved=` is the new address, `https` only.
- Only the domain has to be kept: the old machine can be switched off.

When a device finds the old address silent, it reads that record, asks the new
address to sign a nonce of its own (`GET /api/health?proof=<nonce>`), and moves
the pairing there only if the signature checks against the **identity key**
it pinned when it first paired (`identity_key` in `/api/health`). Its members,
their sessions and its push routing stay as they were.

The identity key is an Ed25519 pair made on the household's first boot,
kept in `households.identity_key` (`server/src/services/householdKey.ts`). It is
the household's, not a member's credential, so **both** archives carry it — the
console's and the hosted account page's. A forged TXT record can point a device
at any server; it cannot make the device follow, because no other server holds
the key.

What a changed name still costs:

- With the hosted archive (account page), sessions and PINs do not travel:
  the device finds the household, and each member signs in again with a code
  from the admin. With the console's archive they do, and nothing is asked.
- A device that paired before its app knew about keys pins the key at its
  next launch; a device that never reached the household between that update
  and the move cannot follow and pairs again by hand.
- Names under `*.ts.net` (Tailscale) cannot carry a TXT record: a household
  leaving one is paired again by hand.
- The apps' universal links cover `*.chezmaurice.eu` only; elsewhere the
  invitation link opens the page in the browser first.
