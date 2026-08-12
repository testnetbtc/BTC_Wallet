# Olesia Wallet — Phase 2 Remediation Report (Secret Protection)

**Repository:** https://github.com/testnetbtc/BTC_Wallet — branch `main`
**HEAD at time of report:** `38bef01d08cbb3d7fa9508a961fc699d735db843`
**Scope:** Phase 2 of the security remediation order — P3 (vault/PIN authentication),
P5 (secret-leakage audit), P6 (backup re-audit), P7 (BIP39 passphrase handling).
**Deployment:** live on `preview` (preview.olesia-wallet.pages.dev); production
(app.olesia.io) unchanged pending review.

Each finding was investigated against HEAD before any change. The complete suite is
now **13 groups, all passing**.

## Finding summary

| ID | Severity | Finding | Original | Final | Commit | Evidence |
|----|----------|---------|----------|-------|--------|----------|
| P3 | HIGH | 6-digit PIN is the sole entropy over a mainnet seed | Confirmed | Fixed | `434c7…`→P3 commit | `test/vault.test.mjs` (+14) |
| P5 | — | Secrets could leak via logs/network | **Not reproducible / already clean** | Proven clean | (P5 commit) | `test/leak.test.mjs` |
| P6 | LOW | Legacy backup metadata unauthenticated | Partially confirmed | Fixed + proven | (P6 commit) | `test/backup.test.mjs` (18) |
| P7 | MED | No way to confirm a passphrase was entered correctly | Confirmed | Fixed | (P7 commit) | `test/passphrase.test.mjs` |

---

## P3 — Persistent vault authentication  [CONFIRMED → FIXED]

**Original.** `src/vault.js sealSeed` accepted any ≥6-char secret; KDF is
scrypt `N=2^15, r=8, p=1`. A 6-digit PIN is the whole protection for a persisted seed.

**Benchmark (documented, as ordered).** Measured on this VPS CPU: **~293 ms per scrypt
attempt**. A 6-digit PIN is ~20 bits (1,000,000 combinations). Because the encrypted
vault lives in `localStorage`, an attacker who copies it grinds **offline** — server
rate-limiting is irrelevant. At a modest 10⁵ scrypt-guess/s:

| PIN length | keyspace | time @ 1e3/s | @ 1e5/s | @ 1e7/s |
|---|---|---|---|---|
| 6 digits | 10⁶ | ~17 min | **~10 s** | ~0.1 s |
| 8 digits | 10⁸ | ~28 h | ~17 min | ~10 s |
| 10 digits | 10¹⁰ | ~116 d | ~28 h | ~17 min |
| 6 BIP-39 words (66 bits) | 2⁶⁶ | ~10¹³ yr | ~10¹¹ yr | ~10⁹ yr |

Verdict: adequate for worthless testnet coins, **inadequate as the sole protection
over a mainnet seed.**

**Fix (Option A of the order).** Option B (WebAuthn/passkey PRF-derived key) was
evaluated and deferred: PRF-extension support across browsers/authenticators is still
too uneven to make it the *only* way to protect a mainnet seed. It is documented as the
preferred future direction. Option A implemented now:

- `generateVaultPassphrase(n)` — Diceware from the BIP-39 wordlist, **exact** entropy
  `n × log₂(2048)` (6 words = **66 bits**); `% 2048` is unbiased (2³² is a multiple of 2048).
- `secretStrength()` — reports **exact** bits for a word-passphrase; for an arbitrary
  typed password it claims **no** bit count (unverifiable) — no invented entropy numbers.
- `meetsMainnetBar()` — mainnet requires a ≥6-word passphrase **or** a 12+ char, 3+
  character-class password. A 6- or 12-digit numeric PIN is rejected.
- `sealSeed(…, {requireStrong})`; `vault.save(mnemonic, pin, passphrase, network)` sets
  `requireStrong` on mainnet only. The set-PIN sheet opens in passphrase mode on mainnet
  with a **"🎲 Generate a strong passphrase (66 bits)"** button and a live strength line.
- **Testnet keeps the convenient 6-digit PIN** (mainnet-vs-testnet policy, per the order).

**Evidence.** `test/vault.test.mjs`, +14 checks: exact 66-bit entropy, no invented bits
for typed passwords, the bar rejects 6/12-digit PINs and a 5-word passphrase (55 bits),
accepts a 6-word passphrase and a 12+ char mixed password, and `sealSeed` enforces on
mainnet only while testnet still accepts a PIN.

---

## P5 — Secret-leakage audit  [NOT REPRODUCIBLE / ALREADY CLEAN → PROVEN]

**Investigation.** No `console.log` of secrets in shipped code (only the `assemble.mjs`
build script logs a byte count). No analytics, Sentry, `sessionStorage`, `indexedDB`, or
`sendBeacon`. No secrets in URL/query/history. The only `fetch` bodies carry **`txHex`**
— a signed transaction, public by definition, about to be broadcast.

**Action (regression proof).** `test/leak.test.mjs` installs a `fetch` spy and proves:
derive/build/sign/seal/describe make **zero** network calls; the sealed vault blob
contains no seed word; and `broadcastRaw` sends **only** the public tx hex — no request
body contains the mnemonic, any seed word, the passphrase, or the private-key hex.

---

## P6 — Backup re-audit  [PARTIALLY CONFIRMED → FIXED + PROVEN]

**Investigation.** `src/coldbackup.js` v3 is sound: KDF params are **pinned** (a
memory-bomb file is rejected *before* scrypt runs), and metadata is bound as AEAD
**associated data**, so any change to it fails the MAC. Gap: legacy **v1/v2** files carry
**unauthenticated** outer metadata (the mnemonic itself is always AEAD-protected and
cannot be forged).

**Fix.** `decryptColdBackup` now returns `metadataAuthenticated` (true only for v3); the
file-import UI warns when importing a legacy file that its labels are not authenticated —
"only the seed itself is verified." (No silent action on unauthenticated metadata.)

**Evidence.** `test/backup.test.mjs`, 18 checks: a genuine v3 file (built with the
generator's own `encryptBackup`) decrypts and reports authenticated metadata; tampering
**any** field — network, path, addressHash, passphraseUsed, version, ciphertext, nonce,
salt — fails cleanly; inflated `N`/`r` (memory bomb) are rejected pre-scrypt; and
malformed / wrong-format / unknown-cipher / missing-password inputs are all rejected.

---

## P7 — BIP39 passphrase handling  [CONFIRMED → FIXED]

**Investigation.** Mnemonic and passphrase are correctly separated in `wallet.js`, and
the "same 24 words + different passphrase = a completely different wallet" warning
exists. Missing: a way to confirm the passphrase was typed **correctly** — a wrong
passphrase still opens a *valid-looking* (empty) wallet, the classic silent-loss trap.

**Fix.** `OW.fingerprint(source, network, passphrase)` returns a short, non-reversible
code (`XXXX-XXXX`, a hash of the account xpub — which the wallet already exposes for
watch-only, so it leaks nothing new). Shown on wallet open when a passphrase is set, and
in the seed backup viewer, so a user can confirm a restore used the **right** passphrase.

**Evidence.** `test/passphrase.test.mjs`: a passphrase (and a one-character change)
yields a different address; the fingerprint is deterministic for the same words+pass,
changes with no-passphrase / a one-char change / a different seed, and has the expected
`XXXX-XXXX` shape.

## Test results

`npm test` — 13 groups, all passing:

```
TX ✓ · PSBT ✓ · SCRIPT-TYPES ✓ · P2PK ✓ · VAULT ✓ (+mainnet policy) · WIF ✓
FEE ✓ · FREEZE ✓ · PSBT-VERIFY ✓ · LEAK ✓ · BACKUP ✓ · PASSPHRASE ✓ · UI ✓
```

## Residual notes (honest)

1. **WebAuthn/passkey (Option B) is not implemented** — deferred due to uneven PRF
   support; documented as the preferred future direction. Mainnet protection currently
   rests on a user-held strong passphrase (Option A).
2. **Typed-password entropy is unverifiable** — the wallet says so and steers users to
   the generated passphrase (exact entropy). The typed-password gate is a structural
   floor (length + character classes), not a measured bit count.
3. **Browser memory** cannot be guaranteed zeroised (JS strings are immutable/GC'd); no
   claim of secure wipe is made. `lock()` reloads the tab to drop the seed from memory.
   This is scheduled for explicit treatment in Phase 2's "memory/UI secret handling" note
   and the SECURITY.md rewrite (Phase 6).
4. Legacy **v1/v2** backups remain importable (the seed is always authenticated); only
   their non-authenticated labels are flagged, not trusted.

These are **internal reviews and automated adversarial tests, not an independent audit.**

## Not yet started (pending review)

Phase 3 (HD receive/change chains, gap-limit recovery, descriptor/xpub interoperability,
wrong-network protections) and Phases 4–6.
