# Olesia — an educational Bitcoin wallet

**Learn Bitcoin, safely.** Practise with real keys, real transactions and every script type on
test networks where mistakes cost nothing — we believe it's the first wallet to combine a faucet
*and* every Bitcoin script type in one open, verifiable place. **Please don't store meaningful
amounts of Bitcoin here — it's a learning tool, not a bank.** → **[Manifesto](docs/MANIFESTO.md)**

**Live:** landing <https://olesia.io> · wallet <https://app.olesia.io> · cold generator
<https://offline.olesia.io> · node broadcast `https://api.olesia.io`
(also on `*.pages.dev`).

**[Security audit](AUDIT.md)** · **[Audit brief — run your own](docs/AUDIT_BRIEF.md)** ·
**[Audits (public)](audits/)** · **[Verify this is genuine](VERIFY.md)** · **[Roadmap](docs/ROADMAP.md)**

`index.html` (cold generator) SHA-256: `77a2752609d5895fbe37577cf6226e975442203ceb11cfa5b712cc6f79ae569c`

> The hosted copy is for demonstration and testnet. For a wallet you will fund,
> **download `index.html` and open it offline** — a hosted key generator means
> re-fetching code from a server on every visit, and whoever controls that server
> controls your keys. The published hash below lets you verify any copy you download.

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




## Testnet and mainnet

Olesia generates wallets for **both** networks — the selector at the top of the
page switches between them. It **defaults to Testnet3 on purpose**, so you cannot
create a real wallet by accident while experimenting. Choosing mainnet shows a
warning and relabels the button.

The selector offers **Testnet3** and **Testnet4** separately, but be clear about
what that choice means: at the key level they are **identical**. Both use BIP-44
coin type `1'`, both produce `tb1...` addresses, both serialize as `tpub`, so the
generated seed, address, and descriptor are byte-for-byte the same. The label only
records which test *chain* you intend to broadcast on (Testnet4 is the newer
network introduced in Bitcoin Core 28); it changes nothing about the keys.

| | Testnet3 / Testnet4 | Mainnet |
|---|---|---|
| Address | `tb1...` (identical for both) | `bc1...` |
| Derivation | `m/84'/1'/0'/0/0` | `m/84'/0'/0'/0/0` |
| Extended key | `tpub...` | `xpub...` |
| Coins | free, worthless | real |

### Checking the entropy

You cannot statistically *prove* a single 256-bit value is "good" — any competent
RNG produces 32 bytes that look perfectly random. Olesia instead gives you two honest
checks. The output reveals the **raw 256-bit entropy hex**: paste it (offline) into
any independent BIP-39 tool and confirm it yields the same 24 words — the hex↔words
map is a bijection, so this proves the page hid or weakened nothing. And a **"Test
the RNG"** button runs a monobit + byte-uniformity smoke test that catches a grossly
broken or stuck RNG. Neither is a cryptographic guarantee; the real assurance is the
source (`crypto.getRandomValues`) plus the reproducible build.

(The GitHub account name is unrelated to what the tool produces.)

## Saving your wallet to disk

**Why there is no `wallet.dat`.** `wallet.dat` is Bitcoin Core's internal
Berkeley DB database, not a portable wallet format — and Core is retiring it
(legacy BDB wallets can no longer be created in recent versions). A file merely
*named* `wallet.dat` that Core cannot load would be worse than useless: it would
look like a backup and fail when you needed it. So Olesia offers the two things
that actually work instead:

**1. Encrypted backup (`olesia-backup-*.json`)** — your 24 words encrypted under a
password you choose.

- KDF: **scrypt N=2^16, r=8, p=1** (64 MB memory-hard, ~1-2 s in-browser). Chosen
  so a leaked backup resists offline guessing. For contrast, 250 PBKDF2
  iterations — a real bug found in another wallet library — buys almost nothing.
- Cipher: **XChaCha20-Poly1305** (authenticated, so tampering is detected and a
  wrong password fails cleanly rather than yielding garbage).
- Your **BIP-39 passphrase is deliberately NOT stored** in the file. That keeps
  its purpose intact: the file alone is not enough. On restore you re-enter it,
  and Olesia confirms it by checking the derived address matches the one recorded
  in the backup — so a mistyped passphrase is caught immediately.

**2. Watch-only descriptor (`olesia-descriptor-*.txt`)** — an output descriptor
(`wpkh([fingerprint/84h/coin h/0h]xpub.../0/*)#checksum`) importable into Bitcoin
Core (`importdescriptors`) or Sparrow to watch the balance. It contains **no
private key**, so it is safe to keep on an everyday machine.

The descriptor checksum implementation is differential-tested against Bitcoin
Core's own reference implementation (`test/framework/descriptors.py`) and matches
byte-for-byte across a range of descriptors.

**Backup privacy (v2).** The file stores `sha256(address)` rather than the address
itself, so anyone who obtains the backup *without* the password cannot learn which
on-chain address it belongs to (and therefore cannot look up its balance). Restore
still verifies by comparing hashes. Version 1 backups, which stored the address in
cleartext, are still readable.

**Test your backup before you rely on it.** The page has a restore panel: load
the file back, enter the password, and confirm the recovered phrase and address
match — while the original is still on screen. An untested backup is not a backup.

## Verify what you downloaded (reproducible build)

The build is byte-deterministic: rebuilding from source produces an identical
`index.html`. So you can confirm the file you downloaded is exactly what this
source tree produces, with nothing inserted.

```
sha256sum index.html
# expected: 77a2752609d5895fbe37577cf6226e975442203ceb11cfa5b712cc6f79ae569c
```

Or rebuild it yourself and compare:
```
npm install && npm run build && sha256sum index.html
```

If the hash differs from the committed file, do not use it.

## Tests

`npm test` runs seven gates, all of which must pass:

1. **BIP-39 vectors** — official Trezor test vector (mnemonic + seed, passphrase "TREZOR").
2. **BIP-84 vector** — derives `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu` from the
   spec's reference mnemonic.
3. **Network correctness** — mainnet yields `xpub`/`bc1`, testnet yields `tpub`/`tb1`.
4. **Backup round-trip** — encrypt, decrypt, wrong password rejected, mistyped
   BIP-39 passphrase detected via address mismatch.
5. **Backup privacy** — the file leaks neither the mnemonic nor the address.
6. **Self-check latch (sabotage test)** — the self-check is deliberately forced to
   fail, and the test asserts that no interaction can re-enable generation.
7. **UI logic (headless)** — passphrase-mismatch blocks generation, backup
   verification rejects wrong words and accepts right ones, save/restore works,
   wipe clears secrets.

## Deploying

The page is a single self-contained file; hosting needs no build step.

```
cp index.html public/
npx wrangler pages deploy public --project-name=alea-wallet --branch=main
```

After deploying, verify the live page matches the audited build:
```
diff <(curl -s https://alea-wallet.pages.dev | sha256sum) <(sha256sum < index.html)
```

## Build

```
npm install
npm run build     # bundles audited libs -> dist/, assembles index.html
npm test          # verifies against official BIP-39 + BIP-84 test vectors
```
`index.html` is fully self-contained; open it in any browser (ideally offline).

## License
MIT. No warranty. You are responsible for your own keys and funds.
