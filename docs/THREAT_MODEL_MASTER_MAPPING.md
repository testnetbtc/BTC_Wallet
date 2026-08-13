# Olesia — Master Threat Model, mapped to our controls

This maps the external "Bitcoin Wallet + Faucet + Node + Explorer" master threat model
onto **what our code actually does**, with file evidence. It complements
[`THREAT_MODEL.md`](./THREAT_MODEL.md) (the design-level model) by going item-by-item.

**Legend:** ✅ control present · ◐ partial / accepted-with-reason · ⚠→✅ gap found & fixed · ➖ not applicable (with reason)

**Scope reminder.** Olesia's wallet is an explicit **hot / learning** wallet (keys in the
browser, small amounts, testnet-first); real value is meant for the offline **cold
generator** + air-gap PSBT flow. The faucet is **testnet-only** (worthless coins),
single-process, localhost-bound behind a Cloudflare tunnel. Several master-model items are
Tier-0 for a *mainnet custodial* system but lower-stakes here — noted where so.

---

## §1A — Cryptographic key-recovery

| # | Item | Status | Control / evidence |
|---|------|--------|--------------------|
| 1 | Weak entropy / predictable seed | ✅ | Root is `crypto.getRandomValues` (OS CSPRNG), 256 bits; mouse/dice are **mixed by hashing only**, can't weaken it. `src/app.js:19-27`, `assemble.mjs:67`. Raw entropy shown for verification. |
| 2 | ECDSA nonce reuse | ✅ | Signing is `@scure/btc-signer` → `@noble/curves` **RFC-6979 deterministic k**; hand-rolled P2PK signs via `secp256k1.sign(h, k, {lowS:true})`. No live RNG for `k` anywhere. `tx.js:79,116,134,172`, `p2pk_fund.js:60,109`. |
| 3 | ECDSA nonce bias / partial leakage | ✅ | Same deterministic-nonce path; we never truncate/inject `k`. |
| 4 | RFC 6979 not used | ✅ | Used (noble default). Verified: no `extraEntropy`/custom-`k` call sites. |
| 5 | Non-hardened BIP32 derivation leak | ✅ | Path is `m/purpose'/coin'/0'/chain/index` — purpose, coin, **account all hardened**. `scripts.js:38`. Shared xpub is the *account* xpub (below a hardened boundary), so a leaked child + xpub can't climb to the account key. |
| 6 | Invalid-curve / small-subgroup | ✅ | `@noble/curves` validates points on secp256k1; we accept external points only as PSBT pubkeys, which the signer validates. |
| 7 | Schnorr / MuSig2 nonce failure | ➖ | No multisig / MuSig. Single-key Taproot uses BIP-340 deterministic nonces in the vetted library. |
| 8 | MPC / threshold flaws | ➖ | No MPC/TSS. |
| 9 | Shared/duplicated factory entropy | ➖ | Entropy is generated per-user in the browser at generate-time; no factory seeding. |
| 10 | Fault injection during keygen/signing | ➖ | Browser software wallet, not a physical signing device. |
| — | Quantum (pubkey-exposed UTXOs) | ◐ | Tracked as a property, not panicked over: P2PK exposes the key immediately, others at spend; address-reuse avoidance (below) limits post-spend exposure. The P2PK explorer doubles as an "exposed-key" map. |

## §1B — Host / endpoint compromise

| # | Item | Status | Control / evidence |
|---|------|--------|--------------------|
| 11 | Seed/key exfiltration | ◐ | It's a **hot wallet** by design — honestly documented. Defences: strict hash-pinned CSP (no inline/eval, `connect-src` allowlist), no analytics, a **leak test** asserting secrets never hit the network (`test/leak.test.mjs`), encrypted-at-rest vault. Real value → cold generator. |
| 12 | Clipboard / address substitution | ✅ | Destination is validated (`assertAddressNetwork`) and the **confirm sheet decodes the actual signed bytes** (not form values) before broadcast (§1C-16). |
| 13 | Secrets not zeroed in memory | ◐ | Browser JS can't guarantee zeroing — **documented limit**; `lock()` hard-reloads to drop the seed. Cold path avoids online key entry entirely. |
| 14 | Rowhammer / cross-tenant memory | ➖ | Client-side browser context; not a shared signing host. |
| 15 | Malicious/compromised backend | ✅ | Mainnet broadcast goes through **our own validating node** (`testmempoolaccept` then `sendrawtransaction`, `infra/broadcast/server.mjs:77-79`); explorers are treated as untrusted hints; the confirm sheet is the source of truth. |

## §1C — Signing-path & device deception

| # | Item | Status | Control / evidence |
|---|------|--------|--------------------|
| 16 | WYSINWYS (sign what you see) | ✅ | **Freeze-and-broadcast**: build once → `decodeRawTx` the *exact hex* for the confirm screen → broadcast the **same** bytes → `broadcastRaw` recomputes the txid and **aborts on mismatch**. `send.js:244-275`, `ui.js:915-941`. Regression-tested (`FREEZE`/`UI` suites). |
| 17 | SIGHASH misuse | ✅ | `SIGHASH_ALL` only (library default; P2PK explicitly appends `0x01`). No `SINGLE`/`NONE`. `p2pk_fund.js:58,110`. |
| 18 | Descriptor / xpub substitution at setup | ✅ | The offline signer **derives ownership itself** and refuses to sign a PSBT whose inputs aren't this wallet's (`signUnsigned` in `send.js:339+`). |
| 19 | Change-address substitution | ✅ | Change always goes to a **derived own address** — `w.address` or the next unused change index (`send.js:74,231`). Never an external/echoed address. |
| 20 | Multisig coordinator manipulation | ➖ | Single-sig wallet; no coordinator. |

## §1D — Human / process / supply chain

| # | Item | Status | Control / evidence |
|---|------|--------|--------------------|
| 21 | Phishing / fake page | ◐ | Reproducible build + published hash so users can verify authenticity; honest "hot wallet" framing; not fully solvable at the app layer. |
| 22 | Supply-chain compromise | ✅ | Deterministic reproducible build; `npm ci` against committed lockfiles; **hash-pinned CSP** (inline scripts pinned by sha256); **CI secret-scan**; audits published in `/audits`. |
| 23 | Backup / recovery weakness | ✅ | Vault = scrypt (N=2¹⁵) + XChaCha20-Poly1305; cold backup v3 binds metadata as **AAD**; mainnet persistence requires a verifiable high-entropy secret. `vault.js`, `coldbackup.js`. |
| 24 | BIP39 passphrase confusion | ✅ | On open with a passphrase, the wallet shows a **fingerprint** so a wrong passphrase (a different valid wallet) is caught. `ui.js` `walletFP`. |
| 25 | Downgrade / rollback | ✅ | Reproducible artifact + published hash; production tie-back verified on each release. |
| 26 | Hardware side-channel | ➖ | No custom hardware. |
| 27 | Address poisoning | ✅ | Full-address handling; no prefix/suffix matching in send logic. |
| 28 | RBF / conflicting-tx UI deception | ✅ | Balances are **derived from live chain state** each read (not a cache), and all built txs now **signal BIP-125 RBF** so a stuck tx is bumpable rather than mis-displayed. |

## §2 — Faucet / payout API

| # | Item | Status | Control / evidence |
|---|------|--------|--------------------|
| 2A-1 | Race double-claim | ✅ | Single-process Node; `limited()` does a **synchronous check-and-record** (atomic in one event-loop turn) before any await. `server.mjs:66-76`. |
| 2A-2 | Distributed race | ➖ | One instance only; no multi-writer. (If ever scaled out, this needs a DB/fencing lock — noted.) |
| 2A-3 | Broadcast-before-state | ◐ | No payout DB to corrupt; the rate-limit slot is recorded **before** broadcast (fail-closed: a failed send costs the claimant a retry, never a double-pay). |
| 2A-4 | UTXO reservation race | ⚠→✅ | **Fixed:** in-process `reserved` set; selection+reservation happen in one synchronous block and the coin is excluded from concurrent claims until broadcast completes (`finally release`). `server.mjs` `pickFaucetCoins`/`reserve`/`release`. |
| 2A-5 | Reorg accounting | ✅ | "Confirmed" is **never latched** — read live from the node/explorer every time (`esplora.js:37,44`); a reorg simply reflects on next read. |
| 2A-6 | Idempotency gaps | ◐ | No idempotency key, but also no DB accounting; the per-address/day limit + reservation bound duplicate effects. |
| 2B-7..12 | Sybil / rotation / IP / CAPTCHA / referral | ◐ | Layered friction: Cloudflare **Turnstile**, per-IP (3/hr), per-address (1/day), **global 500/day** cap; Nostr path is per-npub/24h. Address-rotation bypass is expected and caught by IP+global+Turnstile. No referral system to farm. Honest limit: none of this is unbeatable Sybil resistance — it's friction sized to worthless testnet coins. |
| 2C-13 | Amount/param tampering | ✅ | Payout amount is the **server constant `DRIP`**; client supplies only `{network,address}`; response echoes the server value. `server.mjs:23,133,138`. |
| 2C-14 | CSRF / auth on claim | ◐ | CORS origin allowlist + JSON content-type (forces preflight) + required **Turnstile token** on the public path. `server.mjs:29,94-97,127`. |
| 2C-15 | Token replay / JWT flaws | ➖ | No JWT. Turnstile tokens are single-use (Cloudflare-verified); internal token is a fixed shared secret over localhost only. |
| 2C-16 | Header-spoofing rate-limit bypass | ⚠→✅ | **Fixed:** `clientIp` now trusts only `cf-connecting-ip` (set by our tunnel) or the socket peer — the client-settable `X-Forwarded-For` fallback was removed. `server.mjs` `clientIp`. |
| 2C-17 | Timing/oracle side-channels | ◐ | Minor: 429 vs 200 reveals claim state; acceptable for a testnet faucet. |
| 2C-18 | Admin/debug exposure | ✅ | Only `/info` (GET) and `/claim` (POST) exist; no admin/debug routes; bound to `127.0.0.1`. |
| 2D-19..22 | Fee exhaustion / dust / liquidity / pinning | ◐ | Testnet coins are worthless, so economic drain is moot; dust is contained by the drip-sized **0.0011 bank** + periodic consolidation; payouts now RBF-able (anti-pin). |
| 2E-23 | Malformed-address / parser | ✅ | `btc.Address(net(network).btc).decode(address)` rejects malformed/wrong-network; **network validated explicitly**; 4 KB body cap. `server.mjs:119,124-125`. |
| 2E-24 | Integer / unit mistakes | ✅ | Integer **sats** throughout (`DRIP = 100_000`); no float BTC math in the payout path. |
| 2F-25 | Backend / RPC compromise | ◐ | The faucet holds its **testnet** seed and signs in-process, but the only operation is "send `DRIP` to a validated claimed address"; bound to localhost; mainnet broadcast is a separate narrow service. A compromise caps at testnet coins. |
| 2F-26 | Secret sprawl | ✅ | Secrets in `.secrets/` (600, **gitignored**); repo has only `.env.example`; CI secret-scan blocks key shapes. |
| 2F-27 | No circuit breaker | ◐ | Global 500/day cap is a crude breaker; no velocity-anomaly auto-halt (fine for testnet; would add for mainnet). |
| 2G | Mempool deception / webhook spoof / deanon | ✅◐ | Faucet returns a **txid, never "confirmed"**; the notify service verifies against **our own node** (`notify/node.mjs`), not external webhooks; user-privacy improved by wallet-side address-reuse avoidance. |

## §3 — Script & output-type characteristics

The wallet implements **all** the types the model discusses (P2PK, P2PKH, P2SH-P2WPKH,
P2WPKH, P2WSH via descriptors, P2TR, OP_RETURN) and teaches their exposure properties.
Key controls: **address-reuse avoidance** now rotates receive + change for all four
addressed types and **rotates the P2PK key per fund** (§3-1/3 — P2PK/reuse was the worst
exposure). Malleability (§3-11): SegWit inputs + we track by **outpoint** and re-verify the
txid from frozen bytes, never assuming txid stability pre-confirmation. SIGHASH/timelock
(§3-9/10/17): only standard SIGHASH_ALL, no custom timelocks in the default flows. The P2PK
vectors are cross-checked against Bitcoin Core.

## §4 — Transaction lifecycle & mempool

✅ Broadcast ≠ confirmed is modelled (freeze flow, txid-only faucet response). ✅ **RBF**
signalled on every input (all types + both chains + PSBT). ✅ **CPFP** available (used to
unstick a low-fee testnet chain). ✅ Reorg-safe display (chain-derived, never latched).
◐ Fee estimation uses the node estimator / explorer with clamps; per-network drip fee
(signet raised to 8 s/vB for congestion). Pinning: mitigated by RBF; full package-relay
policy is a node-level concern.

## §5 — Node / P2P / infrastructure

✅ Our **own validating node** is the source of truth for mainnet; RPC is **localhost-only**
behind a tunnel; broadcast runs `testmempoolaccept` first. ◐ Single node → eclipse/BGP/DNS-seed
resistance is limited (we don't multi-home); acceptable given the node is *ours* and used as a
validator, not a wallet backend that others trust. Parser safety: we rely on Bitcoin Core for
consensus parsing and treat explorer JSON defensively (escaped before render — audit L-2 fix).

## §6 — Cross-cutting operational security

✅ Secrets out of git/logs (gitignore + CI scan). ✅ Hot/cold split (cold generator + air-gap
PSBT for real value). ✅ Reproducible/pinned builds + production tie-back on each release.
✅ Dependency integrity (lockfiles, `npm ci`, `npm audit`). ◐ Least-privilege: web/wallet tiers
hold no mainnet spending keys; the *testnet faucet* holds its own throwaway seed. ◐ Monitoring:
heartbeats + daily reports exist; velocity-based auto-halt is not yet wired. ➖ Insider/key-ceremony:
single-operator project, no cold reserves to guard.

## §7 — Research lab

The platform **is** the lab the model describes: a testnet faucet spanning every script type,
a P2PK/exposure explorer, differential script-classification vs Bitcoin Core, and
RBF/CPFP/reorg experiments run on testnet/signet we control.

## §8 — Boundary failures (highest-value)

Covered by design: *authorized vs signed* (frozen bytes), *broadcast?* (own node),
*replaceable?* (RBF-aware, chain-derived), *confirmed?* (own node, revocable), *which script
type?* (classified vs Core), *balance* (validated, never cached-as-truth). The rule "never let
a cache/optimism be the source of truth for money" holds throughout.

---

## Gaps found in this pass — and their disposition

1. **UTXO reservation race** (§2A-4) — **fixed**: in-process reservation excludes a coin from
   concurrent claims until its broadcast completes.
2. **Spoofable `X-Forwarded-For`** (§2C-16) — **fixed**: only `cf-connecting-ip`/socket trusted.
3. **Stale validation message** (§2E) — **fixed**: lists the actual enabled networks.

## Honest residual limits (by design, not defects)

- Hot wallet = keys in the browser; use the cold generator for real value.
- Browser JS can't guarantee memory zeroing.
- Faucet Sybil resistance is *friction*, not a proof (worthless testnet coins).
- Single node → limited eclipse/routing resistance.
- No mainnet custody, so no cold-reserve ceremony / velocity circuit-breaker yet.

*Living document — extend an item with the specific control the moment code changes.*
