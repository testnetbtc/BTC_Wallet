# Alea — Security Audit Report

**Artifact:** `index.html` (single self-contained page)
**Version audited:** commit at time of this report
**SHA-256 of `index.html`:** `a62264a9b08d775b9b5255b711dee3a6509d2457cd62c03a9d859099e2e95d94`
**Date:** 2026-08-04
**Auditor:** Claude (Anthropic) — the same author that wrote the code.

## ⚠️ Read this first: what this report is, and is not

This is a **rigorous self-review**, not an independent third-party audit. The
same party wrote the code and reviewed it, so it cannot catch a blind spot shared
between authoring and reviewing. **Do not treat "audited" here as "certified safe
by an independent expert."** The genuinely trustworthy checks are the ones **you**
can run without trusting this document at all:

1. **Reproduce the build** and confirm the file is exactly what the readable
   source produces (see `VERIFY.md`). This removes any need to trust the binary.
2. **Round-trip on testnet:** generate a wallet here, restore the 24 words in an
   independent wallet (Sparrow), confirm the same address. Independent software
   agreeing is proof no self-test can give.
3. Have a real third party review the source (it is short: ~360 lines across
   `app.js`, `backup.js`, `ui.js`).

Until at least (1) and (2) are done, treat this as a **learning / testnet tool**
and do not fund a mainnet wallet with more than you can afford to lose.

## Scope

The shipped artifact is one HTML file bundling the application logic and audited
cryptographic libraries. Reviewed:

| File | Lines | Role |
|---|---|---|
| `src/app.js` | ~90 | entropy, BIP-39/32 derivation, address, descriptors |
| `src/backup.js` | ~100 | encrypted backup, restore, descriptor checksum |
| `src/ui.js` | ~180 | DOM handlers, no crypto of its own |
| `assemble.mjs`, `build.mjs` | ~150 | deterministic bundle → `index.html` |

**Cryptographic primitives are NOT hand-rolled.** They are the audited
`@noble`/`@scure` libraries, pinned in `package-lock.json`:
`@scure/bip39@1.3.0`, `@scure/bip32@1.4.0`, `@noble/hashes@1.4.0`,
`@noble/curves@1.4.2`, `@scure/base@1.1.6`, `@noble/ciphers@0.5.3`.

## What was verified (positives)

- **Randomness is fail-safe and correct.** The 256-bit seed is rooted in
  `crypto.getRandomValues` (the OS CSPRNG). Mouse/dice are mixed in only as
  defence-in-depth via hashing, so they can strengthen but never weaken the
  result. There is no `Math.random` in any key path.
- **Derivation matches the standards, tested against official vectors:** the
  BIP-39 mnemonic+seed vector (Trezor), and the BIP-84 address vector
  (`bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`). The page re-runs the BIP-84
  check on load and disables itself if it fails.
- **Descriptor checksums are differential-tested against Bitcoin Core's own
  reference implementation** and match byte-for-byte across many descriptors.
- **Backups use authenticated encryption:** scrypt (N=2¹⁶, memory-hard) +
  XChaCha20-Poly1305. The encrypted file contains **neither** the mnemonic **nor**
  the BIP-39 passphrase, and stores `sha256(address)` rather than the address, so
  a stolen backup does not reveal the on-chain address. A wrong password fails
  cleanly.
- **No secret ever leaves the page:** no network calls, no `localStorage`, no
  `console.log` of key material, nothing written to the URL. Verified by grep and
  confirmed by the self-contained-build check.
- **No XSS surface:** all rendering uses `textContent`; `innerHTML` is never used.
- **Offline-safe:** the only Web Crypto call is `getRandomValues`, which works on
  `file://`. Nothing depends on `crypto.subtle` (which browsers disable offline).
- **Fail-closed generation:** a sabotage test forces the self-check to fail and
  confirms no interaction (typing, network switch, clicking) can re-enable
  generation.
- **Deterministic build:** rebuilding from source yields a byte-identical
  `index.html`, enabling independent verification.

## Findings

No High or Critical findings. All items below are Low or Informational.

### F-1 (Low, FIXED) — unbounded KDF parameters on restore
`decryptBackup` previously passed the file's `kdf.N` straight to scrypt, so a
maliciously-crafted backup with `N = 2³⁰` could exhaust memory / hang the tab on
restore. **Fixed:** parameters are now bounds-checked (N a power of two in
[2¹⁴, 2²⁰], r ≤ 32, p ≤ 16, dkLen = 32) before scrypt runs, with a regression
test. Exposure was low regardless — you only ever restore your own files.

### F-2 (Low, documented) — backup metadata not authenticated
The `network`, `path`, and `addressHash` fields sit outside the AEAD. Tampering
with them **cannot reveal the mnemonic** (it is encrypted and its ciphertext is
authenticated), but could cause a restore to derive the wrong network and show a
false "address does not match." Impact is a confusing restore, not key loss.
**Remediation (not yet applied, to keep the format stable):** bind the metadata
as AEAD associated data (AAD). Tracked as a known low item.

### F-3 (Informational) — modulo bias in the backup-verification quiz
The two words the page asks you to re-type are chosen with `r % 24`, a negligibly
biased selection. This affects **only which word you are quizzed on**, never key
generation. No security impact.

### F-4 (Informational) — JavaScript memory cannot be zeroed
"Wipe screen" clears the display and drops references, but immutable JS strings
may persist in memory until garbage-collected. This is **inherent to every
browser-based wallet**: a compromised or memory-dumped machine defeats any web
wallet. Generate real wallets on a clean, offline machine.

### F-5 (Informational, recommended) — no Content-Security-Policy
A strict CSP (e.g. `connect-src 'none'`) would harden the **hosted** case by
blocking any network egress even from injected code. Not yet added because it
must be browser-tested against the Blob-based backup download first (a CSP that
breaks "save backup" would be worse than the marginal gain). Recommended as a
tested follow-up. Note: offline use has no network to egress to regardless.

### F-6 (Informational) — dev-only dependency advisory
`esbuild` (the bundler) has advisory GHSA-67mh-4wv8-2f99, which concerns its
**dev server** — a feature this project never uses. esbuild runs only at build
time and contributes no code to the shipped `index.html`. No user exposure. Bump
at convenience.

## Residual risk (true of any web wallet, not fixable in code)

- **Supply chain when hosted.** Visiting the hosted URL re-fetches code from a
  server each time; whoever controls that server controls the keys. Mitigation:
  the build is deterministic and its hash is published — verify it (see
  `VERIFY.md`), and for real funds, **run the downloaded file offline**.
- **Endpoint security.** Malware, a compromised browser extension, or a
  screen-grabber on your machine defeats any software wallet. For meaningful
  value, a dedicated hardware wallet remains the stronger choice; Alea is a
  low-friction generator and learning tool, honestly labelled as such.

## Verdict

Within the limits stated at the top: the cryptographic design is sound, built on
audited primitives, tested against official vectors, fail-safe on randomness, and
leak-free. The remaining findings are Low/Informational. **This is a credible,
honestly-built tool for testnet and learning, and a reasonable base for small
mainnet use after you complete the independent reproduce-and-round-trip checks in
`VERIFY.md`** — not a substitute for a hardware wallet or an independent audit for
large sums.
