# Olesia — Independent Audit Brief

This is an open invitation to audit Olesia — the cold generator, the online wallet,
the backend, and the website. **Anyone** (AI or human) may run an audit and submit it;
results are stored publicly in [`/audits/`](../audits/). The goal is that no one has
to *trust* this project — they can *verify* it.

Please read `docs/MANIFESTO.md` first for what Olesia is (an **educational** wallet;
not for storing meaningful funds).

---

## What to audit (scope, by priority)

### 1. Cold generator — the crown jewel · `offline.olesia.io`
Source: `src/app.js`, `src/backup.js`, `src/ui.js`, `assemble.mjs`, `build.mjs`.
The shipped artifact is a single reproducible `index.html` (published SHA-256 in
`README.md`). A bug here can cost real funds, so this is the highest priority.
Check:
- **Entropy** — is the 256-bit seed sourced only from `crypto.getRandomValues`? Any
  path where weak/predictable randomness reaches key material? Does folding in mouse/
  dice ever *weaken* the result?
- **Derivation** — BIP-39/32/84 correctness; network/version-byte handling; the
  on-load BIP-84 self-check and fail-closed behaviour.
- **Backup crypto** — scrypt + XChaCha20-Poly1305; the v3 AEAD-AAD metadata binding;
  the exact-KDF-param check (DoS); any way a stolen backup leaks the mnemonic,
  passphrase, or address.
- **Leakage / XSS** — anything to network, storage, URL, or console; `innerHTML` use.
- **Reproducibility** — does `npm run build` reproduce the published hash byte-for-byte?

### 2. Online wallet · `app.olesia.io`
Source: `packages/bitcoin/src/*`, `packages/bitcoin/web/*`. A browser hot wallet that
signs locally with `@scure/btc-signer`.
Check:
- **Signing** — RFC-6979 determinism; correct tx construction (P2WPKH), fee/change,
  OP_RETURN, sweep; txid/endianness (cross-checked against Bitcoin Core in the tests).
- **Air-gap PSBT flow** — watch-only (xpub) build → offline sign → broadcast; the seed
  must never be required to *build*.
- **Mainnet gating** — hot mode is an explicit opt-in; is the seed handled sanely?
- **Network isolation** — the online wallet must never be able to touch the offline
  generator; CSP `connect-src` allow-list (mempool.space, blockstream, api.olesia.io).
- **Seed handling** — never stored (no localStorage of secrets), never logged.

### 3. Broadcast service / tunnel · `api.olesia.io`
Source: `infra/broadcast/server.mjs`. A localhost HTTP service behind a Cloudflare
Tunnel that relays mainnet txs via the operator's node.
Check:
- It holds **no keys** and touches **no wallet** (node runs `disablewallet=1`).
- `/broadcast` validates with `testmempoolaccept` before `sendrawtransaction`; input
  bounds; CORS allow-list; is it safe as a public, unauthenticated relay (abuse/DoS)?

### 4. Website / infra
Landing (`landing/`), CSP headers, the deployment model (Cloudflare Pages), and the
supply-chain story (hosted vs downloaded-and-verified cold generator).

---

## Threat model
Educational wallet, testnet-first, small mainnet amounts only. BUT the **cold
generator can hold real funds**, so treat it as if it does. Out of scope: endpoint
compromise (malware, malicious extensions) and the inherent inability of browser JS to
zero memory — both are documented in `AUDIT.md`.

## The one rule for a real finding
> **A weak primitive is a LEAD, not a FINDING.** Prove it *reaches* key / nonce /
> backup / broadcast material with a concrete exploit path, or say it does not. This
> keeps signal high and is how we separate a real audit from noise.

## How to verify you're reviewing the real thing
- Reproduce the cold-generator build and match the hash (`VERIFY.md`; hash in `README.md`).
- Round-trip a wallet on testnet in independent software (Sparrow / Bitcoin Core).
- CI re-checks reproducibility, runs the test suites, and scans for secrets on every push.

## How to submit an audit
Open a pull request adding a dated Markdown file to [`/audits/`](../audits/) — see
`audits/README.md` for the format. Report privately first for a live vulnerability
(see `SECURITY.md`). Valid reports are credited.

---

## Ready-to-paste prompt for an AI auditor

```
You are an independent security auditor. Audit the Olesia Bitcoin wallet
(github.com/testnetbtc/BTC_Wallet). Do NOT read AUDIT.md until you've formed your own
findings. Scope, highest priority first: (1) cold generator — src/app.js,
src/backup.js, src/ui.js; (2) online wallet — packages/bitcoin/src/*, /web/*;
(3) broadcast service — infra/broadcast/server.mjs.

Threat model: an educational wallet, but the cold generator can hold real funds —
assume a motivated attacker. Check: entropy sourcing and reachability; BIP-39/32/84
derivation; backup crypto (scrypt + XChaCha20-Poly1305, AAD, KDF bounds); RFC-6979
signing and tx construction; PSBT air-gap (seed never needed to build); secret leakage
(network/storage/URL/console); XSS (innerHTML); fail-open bugs; the broadcast relay
(no keys, validation, abuse).

RULES: a weak primitive is a LEAD, not a finding — prove it reaches key/nonce/backup
material with a concrete exploit path, or label it not-reachable. For each finding:
severity, exact file:line, exploit, fix. End with the single highest risk and whether
you'd trust the cold generator with real BTC. Output as Markdown suitable for /audits/.
```
