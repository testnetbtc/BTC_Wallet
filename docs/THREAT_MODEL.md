# Olesia — Threat Model (online / offline)

Honest description of what protects your keys, what does not, and what each party
could do if compromised. Written for the current system (cold generator + hot
wallet + watch-only + air-gap), not the original seed-only generator.

## Properties and their trust levels

| Property | URL | Handles secrets? | Network |
|---|---|---|---|
| Cold generator | offline.olesia.io | **Yes** — generates seeds | Must be used **offline** (connect-src `'none'`) |
| Hot wallet | app.olesia.io | **Yes** — seed in memory, encrypted vault on device | Talks to explorers + broadcast API |
| Watch-only | app.olesia.io | No — xpub only, cannot sign | Read-only explorer access |
| Landing / faucet / P2PK explorer | olesia.io | No | Informational |

## Where secrets live, and where they never go

- **Seed / passphrase / private keys / WIF / vault key**: created and used **only in
  your browser's memory**. They are never sent to any server (proven by
  `packages/bitcoin/test/leak.test.mjs`: signing/derivation issue zero network calls; the
  only thing broadcast is the public signed transaction). The encrypted vault
  (`localStorage`) holds ciphertext only.
- **What leaves the device**: your *addresses* (to read balances), and *signed
  transactions* (to broadcast). Both are public by nature. A BIP-39 passphrase is never
  written to the backup file.

## The cold-generation security model (read this)

The mainnet-generation `navigator.onLine` block is **UX safety against accidental
online seed generation — NOT a security boundary.** A malicious hosted build controls
its own JavaScript and could remove the check. It does **not** protect against malicious
hosted code, a compromised Cloudflare account, a compromised build pipeline or
dependency, a malicious browser extension, or a compromised OS.

The real security model for cold generation is procedural:

```
obtain a known build  →  verify its SHA-256 against the pinned value (VERIFY.md)
   →  DISCONNECT the machine from the network  →  open the file locally (file://)
   →  generate the seed  →  never reconnect while a secret is on screen
```

Under that procedure the hosted server is not trusted at generation time: you verified
the exact bytes and then went offline. The reproducible build + pinned hash (below) is
what makes "a known build" checkable.

## What each network service is trusted to provide — and what it cannot do

| Service | Trusted for | A malicious version could… | Olesia's defence |
|---|---|---|---|
| **mempool.space / blockstream.info** (Esplora) | UTXOs, history, fee estimates, tx data | lie about balances, return an absurd fee, or omit UTXOs | fee is clamped + shown ([1,1000]/[1,5000] sat/vB); recovery uses your seed's own derivation; a hostile API cannot move funds — it never sees a key and every tx is verified before broadcast |
| **faucet.olesia.io** | testnet drips | rate-limit / deny you | testnet only; no secrets sent |
| **api.olesia.io** | mainnet broadcast (via our node) | drop or delay your broadcast | it only relays the signed tx you already approved; it cannot alter it (the txid is verified against the exact bytes) |
| **challenges.cloudflare.com** | faucet anti-bot (Turnstile) | see your IP for the check | faucet page only; scoped by CSP to that host |

**The invariant:** a network API is never trusted to decide **where your Bitcoin goes,
the amount, the network, the fee ceiling, change ownership, or that you approved the
transaction.** Those are all enforced locally against the actual transaction bytes
(Phases 1–3).

## What the browser environment can leak (honest limits)

- **Addresses ↔ IP**: querying an explorer tells *it* which addresses you care about,
  alongside your IP. This is true of almost every wallet. The real fix is running your
  own node; the app teaches this rather than pretending otherwise.
- **Browser memory** cannot be guaranteed zeroised (JS strings are immutable and GC'd).
  Olesia makes **no** claim of secure memory wiping; "Lock" reloads the tab to drop the
  seed from memory as promptly as the platform allows.
- **Malicious extensions / compromised OS** can read page memory. No web wallet can
  defend against a compromised client OS; for meaningful value use the cold generator +
  air-gap flow, or dedicated hardware.

## Deployment-boundary controls (Phase 5)

Served as real HTTP response headers (verified externally, `tools/verify-headers.mjs`):

- **CSP** with `default-src 'none'`, inline scripts pinned by **sha256 hash** (no
  `script-src 'unsafe-inline'`/`'unsafe-eval'`), `connect-src` limited to the exact hosts
  above, `base-uri`/`form-action`/`frame-ancestors 'none'`.
  - The single documented allowance is **`style-src 'unsafe-inline'`**: inline `style="…"`
    attributes cannot be hashed and carry no script-execution risk.
  - The faucet additionally allows `https://challenges.cloudflare.com` in
    `script-src`/`frame-src`/`connect-src` for the Turnstile anti-bot widget — an explicit
    host allowance, not an inline hatch.
- **Anti-framing / clickjacking**: `X-Frame-Options: DENY` **and** `frame-ancestors 'none'`.
- **HTTPS**: `Strict-Transport-Security` (2y, includeSubDomains, preload). All properties
  are HTTPS-only (Cloudflare Pages); HTTP assumptions are documented as none.
- Plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy` / `Resource-Policy: same-origin`, and a deny-all
  `Permissions-Policy`.

## Integrity chain (what you load == what was reviewed)

Reproducible build → pinned hash → deployed asset, all matched (`docs/PHASE5_REMEDIATION.md`).
Compromise of the website alone should not silently swap the wallet for a hostile one:
the source is public, the build is deterministic, and the served bytes are checkable
against the audited commit.
