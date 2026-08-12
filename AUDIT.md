# Olesia — Security Audit Report

**Artifact:** `index.html` (single self-contained page)
**Version audited:** commit at time of this report
**SHA-256 of `index.html`:** `34625d6d4b3b79000170615305eefbfc2e100f2afe37f5181757ec3d324d8a51`
**Date:** 2026-08-06
**Auditor:** Claude (Anthropic) — the same author that wrote the code; plus responses
to two independent external AI reviews (see the 2026-08-06 revision below).

> **Revision 2026-08-05a (UX only, security model unchanged):** clarified that the
> mouse box only needs movement (no clicking/holding), added a Reset button for the
> optional mouse stir, and added an honest entropy summary at the output stage. That
> summary always states **256 bits — full strength** and merely ticks which optional
> sources were folded in; it is deliberately *not* a variable "wiggle harder = safer"
> meter (the RushWallet-style theatre this project exists to critique). The security
> root remains `crypto.getRandomValues`; mouse/dice/passphrase remain defence-in-depth.
>
> **Revision 2026-08-05b (network labels + entropy verifiability, derivation unchanged):**
> (1) The network selector now offers **Testnet3**, **Testnet4**, and Mainnet. Testnet3
> and Testnet4 derive **identically** — both BIP-44 coin type `1'`, `tb` prefix, `tpub`
> serialization — so seed/address/descriptor are byte-for-byte the same; the label only
> records which test chain you intend to broadcast on. The restore path now treats any
> non-mainnet label as testnet, preserving backward compatibility with old `"testnet"`
> backups. (2) Added an honest way to **check the entropy**: the output reveals the raw
> 256-bit entropy hex (paste into any independent BIP-39 tool offline — it must yield the
> same 24 words; the hex↔words map is a bijection, so this proves the page hid/weakened
> nothing), and a **"Test the RNG"** button runs a monobit + byte-uniformity smoke test.
> That test is explicitly framed as detecting a *grossly broken/stuck* RNG only — it
> cannot prove cryptographic quality, since any competent PRNG passes it. No change to
> key derivation, costs, or the security root.
>
> **Revision 2026-08-06 — responses to two independent external reviews.** The public
> repo was audited by two *different, non-Anthropic* AI reviewers. Both found **no
> Critical/High issue in the cryptographic core** (entropy, derivation, backup
> encryption) and corroborated this self-review; the detailed reviewer raised one
> High on *operational* supply-chain risk (hosted mainnet generation) and several
> Medium/Low hardening items. Changes shipped in response (derivation & security root
> unchanged throughout):
> - **[High → mitigated] Hosted mainnet generation:** mainnet generation is now
>   **blocked while `navigator.onLine` is true**. Testnet is unaffected; a real wallet
>   requires downloading the page and going offline. (Signed offline GitHub Releases
>   are the recommended next step — see F-7 below.)
> - **[Medium → FIXED] Restore DoS (tightened F-1):** `decryptBackup` now accepts
>   **only the exact canonical KDF params** Olesia emits (N=65536, r=8, p=1, dkLen=32);
>   the previous *range* still allowed ~4 GB scrypt at the top of the range. Any other
>   params are refused before scrypt runs.
> - **[Medium-Low → FIXED] Backup metadata now authenticated (F-2):** new **v3 backup
>   format** binds `network`, `path`, `addressHash`, `passphraseUsed` as AEAD
>   associated data, so tampering fails the restore (tests added). v1/v2 still read.
> - **[Medium → addressed] Weak backup passwords:** added a one-click **strong-password
>   generator** (6-word Diceware from the wordlist, ~66 bits) and an explicitly
>   *conservative/optimistic* strength hint that steers users to the generator.
> - **[Low] Raw entropy** is now **hidden behind an "Advanced" toggle** (off by default)
>   — keeps the verification path, reduces on-screen exposure.
> - **[Low] BIP-39 passphrase fields** are now `type=password` with a Show/Hide toggle
>   and `autocomplete=off`.
> - **[Low] Backup-verify wording** now says "2 of 24 is a spot-check — do a full
>   restore," not "backup verified."
> - **[Low] CSP added** (`default-src 'none'; connect-src 'none'; …`) as a `<meta>` —
>   **pending a browser round-trip test of the Blob download** (see F-5).
> - **[Info] Wording:** "the CSPRNG always is strong" softened to "on a correctly
>   functioning, uncompromised system"; the RNG button is now a **"liveness check."**

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
3. Have a real third party review the source (it is short: ~440 lines across
   `app.js`, `backup.js`, `ui.js`).

Until at least (1) and (2) are done, treat this as a **learning / testnet tool**
and do not fund a mainnet wallet with more than you can afford to lose.

## Scope

The shipped artifact is one HTML file bundling the application logic and audited
cryptographic libraries. Reviewed:

| File | Lines | Role |
|---|---|---|
| `src/app.js` | ~140 | entropy, BIP-39/32 derivation, address, descriptors, RNG liveness, pw-gen |
| `src/backup.js` | ~115 | v3 authenticated backup, restore, descriptor checksum |
| `src/ui.js` | ~265 | DOM handlers, no crypto of its own |
| `assemble.mjs`, `build.mjs` | ~170 | deterministic bundle → `index.html` |

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

### F-1 (Low, FIXED — then tightened 2026-08-06) — unbounded KDF parameters on restore
`decryptBackup` originally passed the file's `kdf.N` straight to scrypt, so a
maliciously-crafted backup with `N = 2³⁰` could exhaust memory / hang the tab on
restore. First fix bounded the range; an external reviewer correctly noted the
*top* of that range (N=2²⁰, r=32) is still ~4 GB. **Now fully fixed:** restore
accepts **only the exact canonical params** Olesia emits (N=65536, r=8, p=1,
dkLen=32) — anything else is refused before scrypt runs (regression test covers it).

### F-2 (Low → FIXED 2026-08-06) — backup metadata not authenticated
The `network`, `path`, and `addressHash` fields previously sat outside the AEAD.
Tampering could not reveal the mnemonic, but could cause a confusing wrong-network
restore. **Fixed:** the **v3 backup format** binds these fields (plus
`passphraseUsed`) as AEAD associated data, so any tampering fails the restore
(`backuptest.mjs` asserts network/path/addressHash tampers are rejected). v1/v2
files remain readable.

### F-3 (Informational) — modulo bias in the backup-verification quiz
The two words the page asks you to re-type are chosen with `r % 24`, a negligibly
biased selection. This affects **only which word you are quizzed on**, never key
generation. No security impact.

### F-4 (Informational) — JavaScript memory cannot be zeroed
"Wipe screen" clears the display and drops references, but immutable JS strings
may persist in memory until garbage-collected. This is **inherent to every
browser-based wallet**: a compromised or memory-dumped machine defeats any web
wallet. Generate real wallets on a clean, offline machine.

### F-5 (Low → ADDED 2026-08-06, pending browser test) — Content-Security-Policy
A strict CSP is now shipped as a `<meta http-equiv>` tag:
`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'`. `connect-src 'none'` blocks all network egress even from
injected code (the main hosted threat). **Action required:** confirm in a real
browser that the Blob-based "Download encrypted backup", the descriptor download,
and file "Restore" still work under this CSP; if a download breaks, the single
`<meta>` line is trivially reverted. Offline use has no network to egress regardless.

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
  value, a dedicated hardware wallet remains the stronger choice; Olesia is a
  low-friction generator and learning tool, honestly labelled as such.

## Verdict

Within the limits stated at the top: the cryptographic design is sound, built on
audited primitives, tested against official vectors, fail-safe on randomness, and
leak-free. The remaining findings are Low/Informational. **This is a credible,
honestly-built tool for testnet and learning, and a reasonable base for small
mainnet use after you complete the independent reproduce-and-round-trip checks in
`VERIFY.md`** — not a substitute for a hardware wallet or an independent audit for
large sums.
