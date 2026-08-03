# Alea — a 2014-style Bitcoin wallet, done right

An instant, frictionless Bitcoin seed generator in a single offline HTML page —
the RushWallet-era *user experience*, rebuilt on entropy you can actually trust.

Born from a from-scratch study of why the original 2014 browser wallets were
breakable. This is the corrected version: it keeps the wiggle-and-go feel and
fixes the two things that killed the originals.

## Security model (the whole point)

- **Entropy root: `crypto.getRandomValues`** — 256 bits from the OS CSPRNG. This
  is the real security, and it is always strong.
- **Defence in depth: mouse motion + physical dice**, folded in by hashing
  (`SHA-256(csprng ‖ SHA-256(mouse) ‖ SHA-256(dice))`). Because a hash of many
  inputs is strong if *any one* input is strong, these can only help — never
  weaken the result. (You can't launder a weak source, but you *can* safely add
  extra sources onto a strong one.)
- **Standard output: a 24-word BIP-39 mnemonic** (256-bit), optional BIP-39
  passphrase (the "25th word"), BIP-84 native-segwit derivation
  (`m/84'/coin'/0'/0/0`).
- **Deterministic, audited primitives**: `@scure/bip39`, `@scure/bip32`,
  `@noble/hashes`, `@noble/curves`, `@scure/base`. No hand-rolled crypto.
- **Signing** is intentionally *not* implemented here — this is a generator. Any
  future signer must use RFC-6979 deterministic nonces (the flaw that actually
  drained the 2014 wallets was the signing nonce, not the key).
- **Self-verifying**: on load, the page re-derives the official BIP-84 test
  vector (`bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`) and shows PASS/FAIL, so
  you can see the derivation matches the spec before trusting it.
- **No network calls.** The page works with the internet physically disconnected.

## ⚠️ Use it safely

This tool is **new and unaudited**. Treat it the way a careful person treats any
wallet:

1. **Testnet first.** It defaults to testnet (free, worthless coins). Do the full
   loop there — generate, receive, restore in another wallet — before anything real.
2. **Generate offline.** For a wallet you will fund, disconnect from the internet
   first. A web-hosted key generator is a supply-chain risk; downloading this file
   and opening it offline removes it. The page warns you when you're online.
3. **Get it reviewed.** Do not trust it with meaningful money until the code has
   had independent expert review. Until then, a mainnet balance you're fully
   prepared to lose is the honest ceiling.
4. **Back up on paper**, in order. Anyone with the 24 words (plus passphrase, if
   set) owns the coins. Never photograph them, cloud-sync them, or type them into
   any website.

A hosted copy, if published, is for **testnet / demonstration**. For real funds,
download and run offline.


## Verify what you downloaded (reproducible build)

The build is byte-deterministic: rebuilding from source produces an identical
`index.html`. So you can confirm the file you downloaded is exactly what this
source tree produces, with nothing inserted.

```
sha256sum index.html
# expected: 6b663f4ddea98d7f447af50d6fb3b4395c13f881bb59f65d0f5a80468ebce3e4
```

Or rebuild it yourself and compare:
```
npm install && npm run build && sha256sum index.html
```

If the hash differs from the committed file, do not use it.

## Tests

`npm test` runs three gates, all of which must pass:

1. **BIP-39 vectors** — official Trezor test vector (mnemonic + seed, passphrase "TREZOR").
2. **BIP-84 vector** — derives `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu` from the
   spec's reference mnemonic.
3. **UI logic (headless)** — passphrase-mismatch blocks generation, backup
   verification rejects wrong words and accepts right ones, wipe clears secrets.

## Build

```
npm install
npm run build     # bundles audited libs -> dist/, assembles index.html
npm test          # verifies against official BIP-39 + BIP-84 test vectors
```
`index.html` is fully self-contained; open it in any browser (ideally offline).

## License
MIT. No warranty. You are responsible for your own keys and funds.
