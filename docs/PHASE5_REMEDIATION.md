# Olesia Wallet — Phase 5 Remediation Report (Deployment-Boundary Hardening)

**Repository:** https://github.com/testnetbtc/BTC_Wallet — branch `main`
**HEAD at time of report:** `e77322c`
**Scope:** CSP + clickjacking at the HTTP-header level; online/offline threat model;
dependency + supply-chain audit; reproducible-build tightening; and a source → build →
deployment hash chain.
**Deployment:** all changes are on **preview**; production (app.olesia.io, offline.olesia.io,
olesia.io) is unchanged pending final review.

Phase 5 is not wallet cryptography — it establishes that **the thing users load is
genuinely the audited wallet**, and that the host cannot quietly weaken it. Every control
is verified in the **live HTTP response** and in a **real CSP-enforcing browser** —
"configured in the repo" was not accepted as proof.

## Acceptance-bar checklist

| Bar | Result |
|---|---|
| No unexplained dependency findings | ✅ `npm audit` = 0; esbuild advisory explained + fixed |
| No script `unsafe-inline`/`eval` unless unavoidable + justified | ✅ removed everywhere; only `style-src 'unsafe-inline'` + Turnstile host remain, both justified |
| Framing blocked | ✅ `X-Frame-Options: DENY` + `frame-ancestors 'none'` on all properties |
| HTTPS assumptions documented | ✅ HSTS set; HTTPS-only (Cloudflare Pages); see THREAT_MODEL.md |
| Offline behaviour honestly described | ✅ THREAT_MODEL.md (`navigator.onLine` = UX safety, not a boundary) |
| Deterministic/repeatable build demonstrated | ✅ byte-identical across clean rebuilds |
| Deployed hashes matched to the audited commit | ✅ built == served == pinned (below) |

## 1. CSP + clickjacking (real HTTP response headers)

**Before:** CSP existed only in a `<meta>` tag with `script-src 'unsafe-inline'`; the
deployed sites served **no CSP header and no X-Frame-Options** (verified externally) — so
`frame-ancestors` in `<meta>` gave **zero** anti-framing.

**After:** `tools/csp.mjs` hashes each inline `<script>` (sha256) at build time and emits a
Cloudflare `_headers` response header. `script-src` carries only those hashes — **no
`unsafe-inline`, no `unsafe-eval`.** The wallet's 3 inline event handlers were removed
(two `srow` divs → `<a>`, one `msg` handler) so no `unsafe-hashes` is needed either.

Every property now serves: `Content-Security-Policy` (`default-src 'none'`, allow-listed
`connect-src`, `base-uri`/`form-action`/`frame-ancestors 'none'`), `X-Frame-Options: DENY`,
`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy`/`Resource-Policy: same-origin`, deny-all `Permissions-Policy`.

**Justified allowances (the only ones):**
- `style-src 'unsafe-inline'` — inline `style="…"` attributes cannot be hashed and cannot
  execute code.
- Faucet only: `https://challenges.cloudflare.com` in `script-src`/`frame-src`/`connect-src`
  for the Cloudflare Turnstile anti-bot widget — an explicit host, not an inline hatch.

**External verification** (`node tools/verify-headers.mjs preview`) — all 5 endpoints PASS:
wallet, cold generator, landing, faucet, p2pk. Each has the CSP present, no script hatch,
framing blocked.

**Real-browser verification** (headless Chromium, CSP enforced):
- Wallet loads and runs under the strict CSP — `window.OW` functional, `OW.generate()`
  produced a 24-word seed — **zero CSP violations**.
- Cold generator opened from disk (`file://`, where only the `<meta>` CSP applies) —
  `window.Olesia` functional — **zero violations**.
- Faucet + P2PK pages — zero violations once `connect-src` matched their real hosts
  (`faucet.olesia.io`, `mempool.space`).

> Note: Cloudflare Pages applies `_headers` to **GET**, not HEAD — verify with GET.

## 2. Threat model

`docs/THREAT_MODEL.md` documents, explicitly: where every secret lives and that none are
transmitted; the **cold-generation procedure** (verify hash → disconnect → generate →
never reconnect) and that `navigator.onLine` is UX safety, **not** a security boundary
against malicious hosted code / pipeline / extensions / OS; what each network service
(mempool.space, blockstream.info, faucet.olesia.io, api.olesia.io, Turnstile) is trusted
for and — crucially — **cannot** do (a hostile API can never decide destination, amount,
network, fee ceiling, change ownership, or approval); and the honest browser leak limits
(address↔IP correlation, no guaranteed memory wipe).

## 3. Dependency + supply-chain audit

- **`npm audit` = 0 vulnerabilities** (root and `packages/bitcoin`).
- The one finding — **esbuild ≤ 0.24.2 / GHSA-67mh-4wv8-2f99** — affects only esbuild's
  **dev server** (`esbuild serve`), which Olesia never runs (we only call `esbuild.build()`),
  so it was not exploitable. Fixed anyway: bumped to **^0.28.2**.
- **esbuild moved from `dependencies` → `devDependencies`.** It is a bundler, never shipped;
  the cold-gen bundle contains only the crypto libraries. Runtime dependencies are now
  exactly the security-critical set:

| Package | Purpose | Pinned via |
|---|---|---|
| `@noble/hashes` | sha256/ripemd160/scrypt | lockfile v3 |
| `@noble/curves` | secp256k1 (RFC-6979, low-S) | lockfile v3 |
| `@noble/ciphers` | XChaCha20-Poly1305 | lockfile v3 |
| `@scure/base` | base58/bech32/base64 | lockfile v3 |
| `@scure/bip32` | HD derivation | lockfile v3 |
| `@scure/bip39` | mnemonic + wordlist | lockfile v3 |
| `@scure/btc-signer` | tx/PSBT (wallet pkg) | lockfile v3 |

- **Lockfile integrity:** `package-lock.json` (v3) present at root and in `packages/bitcoin`;
  clean installs use `npm ci` (fails on any lockfile drift), not `npm install`.

## 4. Reproducible build

Clean install from the lockfile, then build twice — **byte-identical**:

```
npm ci
npm run build            # cold generator: bundle → assemble → harden
sha256sum public/index.html
# → 77a2752609d5895fbe37577cf6226e975442203ceb11cfa5b712cc6f79ae569c  (identical across rebuilds)
```

The wallet build is likewise deterministic
(`b16f8f669031361c425becbafd88f51455e35ac041b8389dc66dbe57403de3d6`). Node 22, npm 10.9
(`.nvmrc` = 22).

## 5. Source → build → deployment hash chain

Rebuilt from the audited commit, hashed the artifact, fetched the **deployed** asset, and
matched them — plus the pinned value:

| Artifact | Built (repo) | Served (preview) | Pinned | Match |
|---|---|---|---|---|
| Cold generator | `77a2752609…` | `77a2752609…` (preview.alea-wallet) | `77a2752609…` (VERIFY.md) | ✅ |
| Hot wallet | `b16f8f6690…` | `b16f8f6690…` (preview.olesia-wallet) | — | ✅ |

So the exact reviewed bytes are what the browser receives; compromising the website alone
cannot silently swap in a hostile wallet without failing the pinned-hash / reproducible-
build check.

## Reproduce the verification yourself

```
git clone https://github.com/testnetbtc/BTC_Wallet && cd BTC_Wallet && git checkout e77322c
npm ci && npm run build && sha256sum public/index.html          # == pinned cold-gen hash
(cd packages/bitcoin && npm ci && node web/build.mjs && sha256sum web/index.html)
node tools/verify-headers.mjs preview                            # external header proof
# fetch a deployed asset and compare:
curl -s https://preview.alea-wallet.pages.dev/ | sha256sum       # == built public/index.html
```

## Residual notes (honest)

1. **`style-src 'unsafe-inline'`** remains (inline style attributes; no script execution) —
   the only style allowance, documented.
2. **Turnstile host** on the faucet is an external `script-src`/`frame-src` allowance —
   an anti-bot security feature, scoped to the faucet page.
3. **HSTS `preload`** is asserted in the header; actual inclusion on the browser preload
   list is a separate submission step for the apex domain (not yet submitted).
4. Verified on **preview**; the same `_headers`/hashes apply verbatim on promotion.
   Internal + external automated verification, **not an independent audit**.

## Consolidated: what Phases 1–5 establish

- **Phases 1–4:** the wallet behaves correctly (transaction authorisation, secret
  protection, HD architecture with deterministic recovery, and the hand-rolled P2PK) —
  each cross-checked against Bitcoin Core and, where applicable, live networks.
- **Phase 5:** the thing users actually load **is** that wallet, served with a locked-down
  boundary the host cannot quietly weaken.

Phase 6 (rewrite SECURITY.md; consolidated final remediation report) is the remaining
documentation pass.
