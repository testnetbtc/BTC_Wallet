# Olesia audit — 2026-08-10 — Claude (Opus 4.8), author-assisted

> **Update 2026-08-11:** the cold generator was revised (backup-confirmation now requires the full 24 words; added a guided next-steps handoff). The current served hash is `6b8b5fa8a8a516fc0804256cacb48b7b243604c82c79e9870f8e58c296655d04`, which post-dates this audit and warrants re-verification. The hash below is the revision audited on 2026-08-10.

- Commit: `ced4f43`
- Cold-generator `index.html` SHA-256 reviewed: `8873a809524ba65a424902c0b592bd15a7888b3e587244ee04b1ce5caf963ef2`
- Scope: **whole platform** — cold generator, online wallet (`packages/bitcoin`),
  broadcast service (`infra/broadcast`), website.
- Method: adversarial source review of the crypto and tx paths; grep for
  injection/XSS/eval/secret sinks; live test of the broadcast service (rate limit,
  concurrency, resource caps); cross-check of derivation vs BIP test vectors.
- Verdict: **no High/Critical in the crypto core.** Two backend/hardening findings
  fixed in this pass. The dominant risk remains inherent to a *web hot wallet* and is
  addressed by policy (educational, small amounts) and by the cold-generator + air-gap
  paths — not by code.

> Note: same-party review (the author assisted). This is not a substitute for
> independent audit — see `docs/AUDIT_BRIEF.md` to run your own.

## Findings

### F-1 (Medium, FIXED) — broadcast service was an unauthenticated public relay with no rate limiting
`api.olesia.io` → `infra/broadcast/server.mjs` is reachable by any client (CORS only
restricts browser *reads*, not calls) and spawned a `bitcoin-cli` subprocess per
request. A flood could exhaust node/host resources (DoS). It holds no keys and can
only relay valid txs / report public status, so no fund or RCE risk — command
execution uses `execFile` with argument arrays (no shell) and a `^[0-9a-fA-F]+$` hex
filter, so **no injection**. **Fix:** per-IP sliding-window rate limits
(60/min `/status`, 12/min `/broadcast`, HTTP 429), a concurrency cap of 8 in-flight
subprocesses (503 when busy), and systemd resource caps (`MemoryMax=256M`,
`CPUQuota=50%`, `TasksMax=96`, `PrivateTmp`). Verified live: the 13th rapid
`/broadcast` returns 429; node startup unaffected.

### F-2 (Low, FIXED) — mainnet spends allowed unconfirmed inputs
The wallet chained off unconfirmed parents (needed on testnet). With real money that
is riskier (a parent can be replaced/dropped). **Fix:** mainnet send/sweep now require
**confirmed** UTXOs; testnet/signet keep unconfirmed chaining.

### F-3 (Low / privacy, accepted) — change reuses the receive address
Change returns to the wallet's own receive address rather than a fresh change address,
which links UTXOs. Acceptable for an educational single-address wallet; a fresh
change path (`.../1/k`) is a future improvement.

### Positives confirmed
- Signing is `@scure/btc-signer` (RFC-6979 deterministic). Derivation for P2PK/P2PKH/
  P2SH-P2WPKH/P2WPKH/P2TR matches the official BIP-44/84/86 test vectors.
- No `innerHTML`/`eval`/`document.write` in shipped code; DOM built via `textContent`
  + `createElement`. **No XSS sink.**
- The seed is never stored (no `localStorage` of secrets — labels only), never logged,
  never sent; online wallet CSP restricts `connect-src` to the block explorers + the
  own-node API.
- Cold generator: 256-bit entropy from `crypto.getRandomValues`, fail-closed
  self-check, v3 authenticated backups, reproducible single-file build (hash above).

## Dominant residual risk (honest)
A wallet whose page is fetched from a server can, in principle, be served malicious
code by whoever controls that server — no CSP or audit removes this for a *hot* web
wallet. Therefore: **do not store meaningful amounts in the online wallet.** For real
value, use the cold generator (download, verify the hash, run offline) and the air-gap
sign-offline / broadcast-online flow. This is stated in `docs/MANIFESTO.md` and on the
site, and is the actual security model.
