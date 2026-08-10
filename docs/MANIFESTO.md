# Olesia — what this is (and is not)

## Purpose: learn Bitcoin, safely

Olesia is an **educational Bitcoin wallet**. Its goal is to let people *actually
learn how Bitcoin works* — real keys, real transactions, real script types — in an
environment where a mistake costs nothing. You practise on test networks (Testnet3,
Testnet4, Signet), see exactly what a seed, an address, a script, and a transaction
are, and only step up to mainnet when you understand what you're doing.

## Not a bank. Not for savings.

**We do not encourage anyone to store meaningful amounts of Bitcoin in this wallet.**
It is a learning tool, not custody. The online wallet is a *hot wallet* (your seed
lives in the browser tab while you use it) — fine for testnet and for small mainnet
amounts you would be comfortable losing, exactly like any mobile wallet, and nothing
more. For real value, use the cold generator offline, verify the reproducible-build
hash, and keep your seed on paper — or use a hardware wallet. This is stated plainly
and often, on purpose.

## First of its kind

To our knowledge, no other wallet combines all of this in one open, verifiable,
education-first package:

- **A built-in faucet** (planned) so learners can get free test coins instantly and
  start doing real transactions with zero risk.
- **Create a wallet with *every* Bitcoin script type** (planned) — P2PK (Satoshi's
  original), P2PKH (legacy), P2SH, P2WPKH (segwit), P2TR (taproot), bare multisig —
  and send/receive to each, with a plain-English explainer of what each one is and
  why it exists. A living "script museum."
- **Multiple networks in one place** — Testnet3, Testnet4, Signet, Mainnet.
- **Honest, from-scratch cryptography** on audited primitives (`@scure`/`@noble`),
  with a reproducible single-file cold generator whose hash you can verify.
- **Air-gap and own-node paths** — build watch-only, sign offline, broadcast through
  your own Bitcoin node.

## Open and verifiable — by anyone

Everything — the wallet, the website, the backend — is open source and reproducible.
Anyone can rebuild the cold generator and confirm its hash byte-for-byte, read the
code, and run independent audits. Those audits live in this repo (`/audits/`) so they
are public and permanent. See `docs/AUDIT_BRIEF.md` to run one.

## Honesty first

This project began as a study of *why the 2014 browser wallets were breakable*, and
it holds itself to that standard: no security theatre, no overclaiming, clear warnings,
and a documented list of what is and isn't proven. If something is unaudited, it says
so. If a feature is risky, it says so. That honesty is the point.
