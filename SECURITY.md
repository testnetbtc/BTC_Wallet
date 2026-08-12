# Security Policy & Model

Olesia is a **non-custodial Bitcoin wallet and learning tool**. It has grown well beyond
its original offline seed generator: it now generates seeds, restores them, signs and
broadcasts transactions on mainnet and test networks, supports watch-only and air-gapped
signing, and includes several educational features. Because bugs here can cost real funds,
this document describes the security model precisely and honestly — including what has
**not** been independently audited.

> Wording note: this project does not describe itself as "secure", "fully audited", or
> "formally verified". The claim is narrower and checkable: the findings from an internal
> static review have been remediated and tested to the scope documented here, with the
> residual limitations recorded below.

## Reporting a vulnerability

Report privately first — do **not** open a public issue for a real vulnerability. Use
GitHub's **"Report a vulnerability"** (Security → Advisories) on
[github.com/testnetbtc/BTC_Wallet](https://github.com/testnetbtc/BTC_Wallet), which opens a
private advisory thread. Please include affected file(s)/line(s), the concrete exploit path
(how it reaches key / nonce / backup / transaction-authorisation material), severity, and a
suggested fix if you have one.

## Components and where secrets live

| Component | Handles secrets? | Signs? | Network |
|---|---|---|---|
| Cold generator (`offline.olesia.io`) | **Yes** — creates seeds | no | **Must be used offline** (CSP `connect-src 'none'`) |
| Hot wallet (`app.olesia.io`) | **Yes** — seed in memory; encrypted vault on device | yes | explorers + broadcast API |
| Watch-only (xpub) | no — cannot sign | no | read-only explorer |
| Air-gap signer | **Yes** — offline seed signs an untrusted PSBT | yes | none (offline) |
| Landing / faucet / P2PK explorer | no | no | informational |

**Secrets** (mnemonic, BIP-39 passphrase, private keys, WIF, vault key) are created and
used **only in the browser's memory**. They are never transmitted — proven by an automated
test (`packages/bitcoin/test/leak.test.mjs`) that spies on the network layer and confirms
derivation/signing/sealing make **zero** network calls. Only *addresses* (to read balances)
and *signed transactions* (to broadcast) ever leave the device; both are public by nature.

## Trust assumptions

- **Your device and browser are trusted.** No web wallet can defend against a compromised
  OS or a malicious browser extension; for meaningful value use the cold generator + air-gap
  flow (or dedicated hardware).
- **The hosting server is NOT trusted at cold-generation time.** See the offline workflow
  below — you verify the exact bytes, then disconnect.
- **Network APIs are NOT trusted to authorise transactions.** A hostile explorer/broadcast
  API can lie about balances or delay a broadcast, but it can never decide the destination,
  amount, network, fee ceiling, change ownership, or that you approved a transaction. Those
  are enforced locally against the actual transaction bytes.

## Offline workflow (cold generation) — the real security boundary

The mainnet-generation `navigator.onLine` block is **UX safety against accidental online
generation, not a security boundary** (malicious hosted code could remove it). The real
model is procedural and does not trust the server at generation time:

```
obtain a build  →  verify its SHA-256 against the pinned value (VERIFY.md)
  →  DISCONNECT from the network  →  open the file locally (file://)
  →  generate the seed / sign  →  never reconnect while a secret is on screen
```

The reproducible build + pinned hash is what makes "a known build" checkable (see
`docs/PHASE5_REMEDIATION.md`).

## Backup & recovery model

- **Seed phrase (BIP-39):** the wallet *is* its words. Write them on paper, in order.
- **BIP-39 passphrase ("25th word"):** a separate secret applied on top of the words. The
  same words with a different passphrase produce a **completely different wallet**, and a
  wrong passphrase silently opens a valid-looking empty wallet. To catch that, Olesia shows a
  non-reversible **wallet fingerprint** (a hash of the account key) on open and in the backup
  viewer — the same words+passphrase always give the same code. The passphrase is **never**
  written into the encrypted backup file (it is a true second factor).
- **Encrypted on-device vault:** the seed is sealed with **scrypt (N=2¹⁵) + XChaCha20-Poly1305**
  (authenticated) and only the ciphertext is stored. On **mainnet**, a weak numeric PIN is
  refused — persistence requires a strong secret (a generated ≥6-word passphrase = 66 bits, or
  a 12+ char mixed password); testnet keeps a convenient 6-digit PIN. A wrong PIN is an
  authentication failure, not garbage.
- **Encrypted cold-generator backup file (v3):** **scrypt (N=2¹⁶) + XChaCha20-Poly1305** with
  the metadata bound as authenticated associated data; the KDF parameters are pinned (a
  memory-bomb file is rejected before scrypt runs). Legacy v1/v2 metadata is unauthenticated
  and treated as untrusted (the seed itself is always authenticated).
- **Deterministic recovery:** all funds are recoverable **from the seed (+ optional passphrase)
  alone** — no browser-local metadata is required (see gap limit below).

## Supported script types & derivation

| Type | Purpose path | Notes |
|---|---|---|
| Legacy (P2PKH) | `m/44'/coin'/0'` | full support |
| Nested SegWit (P2SH-P2WPKH) | `m/49'/coin'/0'` | full support |
| Native SegWit (P2WPKH) | `m/84'/coin'/0'` | **primary** account; watch-only + descriptors |
| Taproot (P2TR) | `m/86'/coin'/0'` | full support |
| P2PK (bare public key) | `m/44'/…` (museum) | educational; testnet-first (see below) |

`coin` = 0' on mainnet, 1' on test networks. Each type has an external (receive, chain 0) and
internal (change, chain 1) branch. Change is sent to the next unused change address; the
receive address rotates. Derivation was cross-checked against **Bitcoin Core**
(`deriveaddresses`) for both chains.

## Gap-limit behaviour (know this)

Discovery scans each chain until **20** consecutive unused addresses (standard BIP-44 gap
limit), from the seed or an account xpub. Funds received at any index within the gap are
always found. A fund isolated **more than 20 indexes** past the last used address will not be
found at the default gap — a manual rescan at a larger gap finds it. This is a documented
scan-window limitation, not fund loss (the coins remain derivable from the seed).

## Third-party API exposure

| Service | Used for | Exposure |
|---|---|---|
| mempool.space / blockstream.info | UTXOs, history, fee, tx data, price | learns which addresses you query, with your IP |
| api.olesia.io | mainnet broadcast (relays to our node) | sees only the signed tx you approved |
| faucet.olesia.io | testnet drips | testnet only |
| challenges.cloudflare.com | faucet anti-bot (Turnstile) | faucet page only; sees IP for the check |

Querying any explorer correlates your addresses with your IP — true of almost every wallet.
The real fix is running your own node, which the app teaches rather than hides. Fee estimates
are treated as untrusted: clamped to a sane range and shown before you approve.

## CSP / deployment boundary

All properties are served over HTTPS with real HTTP response headers (verified externally,
`tools/verify-headers.mjs`): a Content-Security-Policy with `default-src 'none'`, inline
scripts pinned by **sha256 hash** (no `script-src 'unsafe-inline'`/`'unsafe-eval'`), an
allow-listed `connect-src`, and `base-uri`/`form-action`/`frame-ancestors 'none'`; plus
`X-Frame-Options: DENY`, HSTS, `nosniff`, `no-referrer`, COOP/CORP `same-origin`, and a
deny-all `Permissions-Policy`. The only allowances are `style-src 'unsafe-inline'` (inline
style attributes, no code execution) and the faucet's Turnstile host. Builds are reproducible
and the deployed asset hashes match the audited commit (`docs/PHASE5_REMEDIATION.md`).

## What has — and has NOT — been independently audited

- **Internal static review + remediation:** all findings from an internal review have been
  remediated across Phases 1–6 (`docs/PHASE{1..6}_REMEDIATION.md`).
- **Independent oracles used in testing:** transaction/descriptor/PSBT correctness is
  cross-checked against **Bitcoin Core**; P2PK is additionally verified by a
  separately-coded sighash and by **live acceptance on testnet4 + signet**; the browser
  security boundary is verified against **live deployments** and a real CSP-enforcing
  Chromium.
- **No independent third-party audit has been performed.** "Bitcoin Core cross-checked" and
  "live-verified" are not the same as an external code audit. Treat Olesia as an educational,
  testnet-first wallet; use only small amounts on mainnet until an independent audit exists.

## Full source & verification

Everything needed to verify Olesia is public: the wallet and cold-generator source, the
reproducible-build recipe and pinned hashes (`VERIFY.md`), the test suites, and the
remediation reports. Nothing that would let someone drain or impersonate Olesia (operational
secrets) is in the repository.
