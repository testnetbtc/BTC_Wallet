# Olesia — Roadmap

**Vision:** a Bitcoin wallet that is also a **safe place to learn Bitcoin**. Real
networks, real transactions, real script types — but on testnets where mistakes cost
nothing. Cold generation and honest entropy at the core; playground on top.

Status legend: ✅ done · 🔜 next · 🧭 planned · 💡 idea

---

## Networks
- ✅ Testnet3, Testnet4, Mainnet (selector in app.olesia.io)
- ✅ Mainnet broadcast via the operator's own node (api.olesia.io)
- 🔜 **Signet** — add as a network. Same address params as testnet (BIP-44 coin
  type 1, `tb1…`), separate chain, `mempool.space/signet/api`. **Regular ~10-min
  blocks** (unlike testnet4's erratic timing) → the *best* network for teaching and
  for a reliable faucet. Small, quick add to `networks.js` + selector.
- 💡 **Regtest** — a private, instant-block chain for guided lessons (needs a
  regtest node + API; fully deterministic, great for tutorials).

## Faucet (operator has coins to fund it)
- 🧭 **Testnet3 / Testnet4 (and Signet) faucet** so learners can get free coins to
  play with. Design:
  - A funded testnet hot wallet on the backend dispenses a small amount to a
    requested address (reuses `packages/bitcoin` send/broadcast).
  - Served at e.g. `faucet.olesia.io` (Cloudflare Tunnel, like api.olesia.io) or as
    an endpoint on the broadcast service.
  - **Abuse protection is the hard part** (faucets get drained by bots): per-IP and
    per-address rate limits, small fixed drips, a cooldown, and a lightweight
    challenge (hCaptcha/Turnstile or a small proof-of-work). Cloudflare Turnstile is
    a clean fit since we're already on Cloudflare.
  - Testnet3 mines regularly enough; **Signet is the most reliable** faucet target.

## Script types (a Bitcoin history/education highlight)
- ✅ P2WPKH (native segwit, `bc1/tb1`) — the wallet default.
- 🧭 **P2PK — "Pay to Public Key"** (the ORIGINAL Satoshi script: `<pubkey>
  OP_CHECKSIG`). Educational gold:
  - It's how the genesis-block coinbase and the earliest coins (incl. Satoshi's) are
    held.
  - **No address** — a P2PK output is identified by the raw pubkey/script, so you
    literally can't "send to an address"; you construct the output from the pubkey.
    Teaches what an address really is.
  - Exposes the public key on-chain → the natural hook for the quantum-resistance
    discussion (P2PKH/P2WPKH hide the pubkey behind a hash until spend).
  - Feasible on testnet/Signet where we control both ends: derive pubkey → build
    `Script.encode([pubkey, 'CHECKSIG'])` output → spend by signing that input with
    @scure/btc-signer. Build + broadcast + a clear "what you're looking at" explainer.
- 💡 Other script types for a "script museum": P2PKH (legacy `1…`), P2SH, P2SH-P2WPKH
  (wrapped segwit), P2TR (taproot, `bc1p…`), bare multisig, and a raw OP_RETURN lesson.
  Each with a plain-English explainer of when/why it's used.

## Learning experience
- 💡 Inline "what just happened" explainers at each step (entropy → seed → address →
  tx → broadcast), with links to the relevant BIPs.
- 💡 A **transaction decoder / script viewer** — paste any txid or raw tx and see its
  inputs/outputs/scripts explained.
- 💡 Address-type comparison view (same seed → P2PKH vs P2WPKH vs P2TR side by side).

## Wallet polish (owed)
- 🔜 Offline generator: **copy-address (and copy-words) button**, **more words in the
  backup check** (2 → ~4), and **warnings turn green when offline**.
- 💡 Receive-address QR is done in app.olesia.io; add it to the offline generator too.

## Infrastructure / housekeeping
- 🧭 Merge `feature/chainwatch-infrastructure` → `main` once the platform stabilises.
- 🧭 Signed, immutable GitHub Releases of the cold generator (F-7 from the audit).
- 💡 Chainwatch watch-only dashboard + Telegram alerts (original brief), now that the
  node + broadcast API exist.
