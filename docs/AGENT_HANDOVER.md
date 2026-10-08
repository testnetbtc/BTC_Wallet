> **HISTORICAL DOCUMENT — it does not describe the live wallet.**
> In October 2026 Olesia was re-scoped to a single product: the mainnet hot wallet at <https://olesia.io>.
> This handover describes the platform as of 2026-08-18. Most of what it lists as live is now mothballed.
> Current documentation: [`packages/bitcoin/mainnet/README.md`](../packages/bitcoin/mainnet/README.md) and the top of the main [`README.md`](../README.md).
> What was switched off, and how to restore it: [`docs/MOTHBALL_2026-10.md`](MOTHBALL_2026-10.md).

# Olesia — Full Project Handover for a New Agent

**Last updated:** 2026-08-18 · **Operator:** jon.utxo@pm.me · **You are `faucet` on this VPS.**

This is the single, comprehensive handover for the **Olesia** project. Read it fully before acting.
It covers what Olesia is, every website/app, the engine, the security history, the live
infrastructure, how to build/test/deploy, and exactly where everything stands.

> **Note on other trees on this box.** `/home/faucet/trading` and `/home/faucet/fabletrade` are a
> SEPARATE, unrelated trading-research project (the `/home/faucet/CLAUDE.md` brief belongs to that).
> `/home/faucet/olesia-atomic` is the **atomic-swap engine**, owned by a **different agent** — you
> integrate with it across a fixed contract but **never modify it** (see §8). Olesia itself lives in
> **`/home/faucet/BTC_Wallet`**.

---

## 1. What Olesia is

An **educational, non-custodial Bitcoin platform**, testnet-first. The honest framing rule is
absolute: **never call it "secure", "audited", or "formally verified"** — say *"remediated and tested
to the documented scope, with a rigorous internal assurance program and an air-gap path for real
value."* No paid third-party human audit has been done. It has, however, been through a structured
multi-agent LLM red-team + an independent LLM audit (see §6).

Crypto is audited libraries only: **`@noble` / `@scure`** (RFC-6979 low-S ECDSA, BIP-340 Schnorr,
XChaCha20-Poly1305, scrypt, BIP-32/39). **No bitcoinjs** in the wallet tree.

Surfaces (all §3): landing `olesia.io`, hot wallet `app.olesia.io`, cold generator
`offline.olesia.io`, offline signer (`olesia-signer.pages.dev`, `sign.olesia.io` pending), testnet
faucet `faucet.olesia.io`, node-broadcast API `api.olesia.io`, P2PK explorer `olesia.io/p2pk`, an
iOS app (Capacitor), a Nostr faucet bot, a Telegram notifier, and a read-only ops dashboard.

---

## 2. Repo, build, test

- **Repo:** `/home/faucet/BTC_Wallet` → `git@github.com:testnetbtc/BTC_Wallet.git`, branch `main`.
- **HEAD:** `4042803` — **1 commit unpushed** (the atomic-swap connect feature). Push when the
  operator says so.
- **Engine package:** `packages/bitcoin` (this is where almost everything lives).
- **Build/test** (Node ≥ 22.5 for `node:sqlite`; prod runs v22.22.3):
  ```
  cd packages/bitcoin
  npm ci
  NODE_OPTIONS="--experimental-sqlite --no-warnings" npm test
  ```
  Expect **709 checks / 0 failures / 37 test files**. Tests are plain-Node assertion scripts (no
  framework); some opportunistically cross-check a local Bitcoin Core if present.
- After ANY engine change, keep the suite green.

---

## 3. The surfaces (websites & apps)

Each Cloudflare Pages project is deployed with `wrangler` (see §10). Live health at time of writing:
`olesia.io`, `app.olesia.io`, `offline.olesia.io`, `olesia-signer.pages.dev` all 200.

### 3.1 Landing — `olesia.io`
- Source: `landing/` (static). Deployed as Cloudflare Pages project **`olesia-landing`**.
- Hosts the marketing/education pages **and** `olesia.io/p2pk` (the P2PK explorer, §3.9) and
  `olesia.io/faucet/` (the faucet claim page that calls the faucet API).
- Redeployed daily by the P2PK explorer cron (§9).

### 3.2 Hot wallet — `app.olesia.io`
- Source: `packages/bitcoin/web/` (`entry.js` = `window.OW` API, `ui.js` = the DOM/UX,
  `assemble.mjs` = page assembly, `build.mjs` = esbuild + `tools/csp.mjs` hardening). Built
  artifacts (`web/index.html`, `web/dist`, `web/_headers`, `web/BUILD_HASH.txt`) are **gitignored**
  and regenerated at deploy.
- Cloudflare Pages project **`olesia-wallet`** → `app.olesia.io`. Deploy folder is a **flat**
  staged dir `web/publish/` (index.html + _headers + pwa assets, all at root) — see §10.
- A browser HD wallet: BIP-32/39/44/49/84/86, all script types incl. **P2PK** (`src/p2pk_fund.js`),
  RBF, PSBT air-gap flow, WYSIWYS confirm-then-broadcast-frozen-bytes, encrypted on-device vault
  (`src/vault.js`, scrypt + XChaCha20). Seed generation supports **dice/entropy stirring**
  (`web/entry.js generateFrom` = `SHA-256(CSPRNG ‖ user-entropy)`; see §12 for the open
  "pure-dice trustless mode" enhancement). Has a P2PK "lab" and a testnet **Quick Wallet** design
  (`docs/QUICK_WALLET_DESIGN.md`, not yet built).
- **M5 (delivery integrity):** `web/build.mjs` emits a bundle sha256; `tools/verify-bundle.mjs`
  compares served bytes vs the repo build (`node tools/verify-bundle.mjs production`). The
  Settings "Verify this build" link points to `VERIFY.md`.

### 3.3 Cold generator — `offline.olesia.io`
- Source: `packages/bitcoin/web/site/` (self-contained, network-less seed generator + backup).
  Cloudflare Pages project **`alea-wallet`** → `offline.olesia.io`. Reproducible build; the hash is
  published in `VERIFY.md`.

### 3.4 Offline signer app — `olesia-signer.pages.dev` (custom domain `sign.olesia.io` PENDING)
- Source: `packages/bitcoin/signer/` (`core.mjs` = review+multi-path sign, `entry.js` =
  `window.SIGN`, `index.html`, `build.mjs`). Network-less (`connect-src 'none'`), hash-pinned CSP.
  Air-gap PSBT signing: paste/file PSBT → WYSIWYS review (ownership from account xpub, independent
  fee) → sign → copy/download. Default 24-word, 12-word option.
- Deployed to Pages project **`olesia-signer`**. **Operator TODO:** add custom domain
  `sign.olesia.io` in the Cloudflare dashboard (Workers & Pages → olesia-signer → Custom domains).

### 3.5 Atomic-swap connect bridge — `app.olesia.io/connect` + the `window.olesia` provider
- Source: `packages/bitcoin/connect/` (`core.mjs`, `entry.js`, `index.html`, `build.mjs`,
  `olesia-provider.js`) and the engine signer `src/htlc_sign.js`. Full detail in §8 and
  `docs/SWAP_CONNECT_SETUP.md`. Lets a user sign the Bitcoin side of an atomic swap in their own
  Olesia wallet, non-custodially. **Not yet deployed** (stage into `web/publish/` on next wallet
  deploy; see §8/§10).

### 3.6 Faucet — `faucet.olesia.io` (localhost `127.0.0.1:8790`, Cloudflare Tunnel)
- Source: `packages/bitcoin/faucet/` (see §5). systemd `olesia-faucet.service`. Serves `GET /info`
  and `POST /claim` only (so `/` returns 404 — that's normal). Dispenses testnet3/testnet4/signet
  drips (100k sat) from the operator's stash. **Mainnet payout is HARD-DISABLED.** Backed by the
  RT-2 durable exactly-once claim ledger and, for testnet4, own-node broadcast + reconciliation.

### 3.7 Read-only ops dashboard — `127.0.0.1:8793`
- Source: `packages/bitcoin/faucet/dashboard.mjs`. systemd `olesia-faucet-dashboard.service`.
  Redacted, inert, read-only view of faucet telemetry/breaker/ledger health.

### 3.8 Node-broadcast API — `api.olesia.io`
- systemd `olesia-broadcast.service`. Own-node broadcast endpoint (NODE-1 lineage). Used as the
  wallet's own-node broadcast path where wired.

### 3.9 P2PK explorer — `olesia.io/p2pk`
- Source: `p2pk-explorer/` (`update.sh`, data build + Cloudflare deploy). Cron at 03:30 daily
  builds data and redeploys `olesia-landing`. BigQuery backfill was pending historically.

### 3.10 Nostr faucet bot
- Source: `packages/bitcoin/nostr/` (`bot.mjs`, `dedup.mjs` = RT-6 durable dedup-before-payout,
  `lib.mjs`). systemd `olesia-nostr-bot.service`. Watches mentions → drips via the localhost faucet
  (internal token). Heartbeat `.secrets/nostr-heartbeat.json`.

### 3.11 Telegram notifications / chain watcher
- Source: `packages/bitcoin/notify/` (`bot.mjs`, `chaintracker.mjs`, `addrwatch.mjs` — RT-10
  reorg-aware, deep-reorg fail-safe; `node.mjs`, `feed_client.py`). Alerts on watched addresses
  from our own nodes. See `docs/TELEGRAM_NOTIFICATIONS_BRIEF.md`, `notify/INTEGRATION.md`.

### 3.12 iOS app (Capacitor)
- Source: `mobile/` (`prepare.mjs` builds + stages the hardened wallet into `www/`,
  `capacitor.config.json`, `package.json`). Wraps the web wallet locally in a WebView. **M6/L13
  hardened:** committed `www/index.html` is hash-pinned CSP (no `unsafe-inline`), release build
  fails closed, App-Bound Domains enabled, Capacitor bumped to ^7. **Needs a Mac** (`npm install
  && npx cap sync ios`, Xcode) — Apple Developer org account required. Signing material:
  `.secrets/android-signing.json`, `.secrets/olesia-android.keystore`.

---

## 4. The engine — `packages/bitcoin/src/`

- `wallet.js` — BIP-32/39/44/49/84/86 derivation, `deriveKey`, `accountXpub`, `normalizeMnemonic`,
  `parseExtendedKey`.
- `tx.js` — build+sign P2WPKH (+OP_RETURN), `assertRecipientAmount` (RT-8 integer-sat/dust floor),
  `assertFeeRate`, `assertAddressNetwork`, RBF, **`actualFee` = Σin−Σout honest fee (Kimi M1)**.
- `psbt.js` — air-gap PSBT: `buildUnsignedPSBT` (validated, L10), `describePSBT` (ownership from
  xpub only, independent fee, **nonWitnessUtxo hash-check L1**, sighash surfaced L3, burned-total
  L4), `signPSBTOffline`, `extractTx`.
- `send.js` — orchestration: `prepareAndSend`, `prepareSweep`, `prepareSendHD`, `discoverAccount`
  (gap-limit recovery), `fundP2PK`/`spendP2PK` (**frozen-bytes broadcast L9**), `sweepWIF`,
  `broadcastRaw`, `assertBroadcastTxid` (RT-5), `deriveAt`, `walletAddress`, `decodeRawTx`.
- `p2pk_fund.js` — hand-rolled BIP-143 P2PK fund/spend + `selectFundCoins` coin selection
  (@scure/btc-signer refuses bare-pk outputs, so we serialize P2WSH v0 ourselves).
- `htlc_sign.js` — **atomic-swap HTLC signer** (§8). P2WSH SHA256+CLTV redeem/refund, hand-rolled
  BIP-143, reuses the PSBT's unsigned-tx bytes → segwit txid == engine intent by construction.
- `vault.js` — encrypted seed-at-rest (scrypt N=2^15 + XChaCha20-Poly1305), mainnet strength gate,
  **structural pre-KDF validation L11**.
- `coldbackup.js` — v3 authenticated backup files (scrypt N=2^16). `wif.js`, `scripts.js`,
  `descriptor.js`, `networks.js`, `esplora.js` (external data = advisory).

---

## 5. The faucet system — `packages/bitcoin/faucet/` (RT-2 + own-node trust path)

- `ledger.mjs` — **durable, idempotent, crash-safe SQLite claim ledger** (`node:sqlite`, WAL,
  synchronous=FULL, STRICT). State machine `AUTHORISED→SIGNED→BROADCASTING→SEEN→CONFIRMED` +
  `UNCERTAIN/CONFLICTED/FAILED_SAFE`. `UNIQUE(network,canon,day)` entitlement; durable UTXO
  reservations; NODE-2A quarantine + NODE-2B `retireToGuard` (atomic reservation→guard);
  **immutable-once-set `raw_tx`/`local_txid` guard (Kimi M4)**. Schema v3.
- `claimflow.mjs` — `processClaim` exactly-once engine (write-ahead before every broadcast; exact
  persisted bytes are the only thing rebroadcast). **Advisory (non-authoritative) reconcile capped
  at SEEN/UNCERTAIN — only our own node drives terminal states (Kimi L5).** Signed inputs ⊆
  reservation (M3 defense).
- `server.mjs` — HTTP surface. **M3:** refuses empty-reservation claims. **L7:** Turnstile fails
  closed with no secret. Mainnet hard-disabled.
- `advance.mjs` — routes SEEN/UNCERTAIN/CONFIRMED to the own-node authoritative reconciler; **M4
  per-claim lock (`claimlock.mjs`)**.
- `authreconcile.mjs` — NODE-2 authoritative reconciliation (gettxout UTXO-set, pruned-safe;
  reorg-after-confirm quarantine; retire only at ≥2 conf).
- `nodebroadcast.mjs` — NODE-1 own-node broadcast, **fail-closed, no external fallback**,
  txid-matched.
- `breaker.mjs` — velocity circuit-breaker, atomic, fail-closed, **shape-validated latch (L6)**,
  bounded trip log (RT-7). `recovery.mjs` — periodic non-overlapping recovery worker.
- `telemetry.mjs` — value-scrubbing (RT-9). `dashboard.mjs` — read-only view.

> **Operational gotcha (learned 2026-08-17):** the faucet's testnet4 balance is often **one big
> coin + dust** (signet is healthier: one big coin + ~300 small drip coins). When sending a large
> amount out-of-band, **spend the big coin explicitly** (don't let coin-selection eat the drip
> bank) and, if the network's only large coin is the drip fallback, **stop the faucet during the
> send** so drips don't create a competing double-spend. Verify confirmation via **esplora tx
> status**, not `gettxout` on vout 0 (BIP-69 output order / pruning can false-negative).

---

## 6. Security history

- **Red team RT-1..RT-15** (`docs/RED_TEAM_MASTER_REPORT.md`, `docs/RT2_CLAIM_LEDGER.md`,
  `docs/RT6_RT10_INVESTIGATION.md`): breaker fail-closed, the RT-2 durable claim ledger, broadcast
  txid assertion (RT-5), Nostr dedup-before-payout (RT-6), trip-log rotation (RT-7), integer-sat
  guards (RT-8), telemetry scrubbing (RT-9), reorg-aware notifications (RT-10), etc.
- **Own-node trust path** NODE-1/2/2A/2B — own-node broadcast + authoritative reconciliation +
  reorg quarantine + durable retirement guard (testnet4 live).
- **Kimi K3 independent audit (2026-08-16)** — multi-agent LLM audit: **0 Critical, 0 High, 6
  Medium, 14 Low**. ALL 6 Medium + all actionable Lows fixed in commits `c65eec9`, `dbb21c6`,
  `d7530ed`, `441b1c9`, `4667572` (M1 fee honesty, M2 signer OP_RETURN DOM-escape, M3
  empty-reservation, M4 concurrency guard, M5 delivery integrity, M6 mobile CSP; L1–L14). See
  the commit messages + `test/audit_kimi.test.mjs` + `test/mobile_harden.test.mjs`.
- **9/10 assurance program** (`docs/P1_MAINNET_KEY_CUSTODY_DESIGN.md`, memory `olesia-9-10-program`):
  P1 mainnet key custody = the offline signer app (built) + air-gap flow; P2 reproducible build;
  P3 multi-agent audit (done); P4 differential/fuzz (pending); P5 mainnet forward-test (pending);
  P6 ops hardening. Honest-framing rule stays.
- **Threat model:** `docs/THREAT_MODEL.md`, `docs/THREAT_MODEL_MASTER_MAPPING.md`. **Audit brief:**
  `docs/AUDIT_BRIEF.md` (older; the current state is this handover + the commit history).

---

## 7. Tests — `packages/bitcoin/test/` (37 files, 709 checks)

Crypto/engine: `tx`, `psbt`, `psbt_verify`, `p2pk`, `p2pk_vectors`, `coinselect`, `vault`, `wif`,
`descriptor`, `fee`, `freeze`, `leak`, `backup`, `passphrase`, `wrong_network`, `scripttypes`,
`rt8_amounts`. Signer: `signer`, `signer_app`. Faucet: `breaker`, `ledger`, `rt2_crash`,
`rt2_recovery`, `rt2_reservation`, `nostr_dedup`, `notify_reorg`, `node_broadcast`, `authreconcile`,
`node2a_quarantine`, `node2b_guard`, `advance`, `dashboard`. UI: `ui`. Audit regressions:
`audit_kimi`, `mobile_harden`. Atomic swap: **`htlc_sign`** (engine-accepted redeem/refund,
txid-preserving), **`connect`** (hardened bridge + origin-pinned provider). Live-only (not in the
suite): `e2e_live`, `recovery_live`, `p2pk_live`.

---

## 8. Atomic-swap integration (the newest work)

**Goal:** let a user sign the BTC side of a BTC↔USDC atomic swap in their own Olesia wallet,
non-custodially. The swap engine (`/home/faucet/olesia-atomic`, port 8975, a **different agent's**
tree) verifies signed bytes semantically against an immutable intent and broadcasts — it never holds
a key. **The contract file `/home/faucet/olesia-atomic/docs/OLESIA_WALLET_HANDOFF_CONTRACT.md` is the
WHOLE boundary. Do NOT modify the swap tree.**

Built on the Olesia side (committed, HEAD `4042803`, unpushed):
- `src/htlc_sign.js` — P2WSH SHA256+CLTV HTLC redeem/refund signer. Reuses the PSBT's unsigned-tx
  bytes so the finalized **segwit txid equals the engine intent by construction**. Fail-closed
  (branch key must be in this wallet; SIGHASH_ALL only; P2WSH must match witnessScript; redeem
  secret must hash to the HTLC's H). **Gold-standard validated:** the engine's own
  `verifySignedAgainstIntent` accepts the wallet-signed redeem+refund bytes.
- `connect/` — the `window.olesia` provider (origin-pinned popup relay, holds no keys) + a
  network-less hardened bridge page (`app.olesia.io/connect`) that unlocks the same-origin vault,
  shows a WYSIWYS review, and signs `olesia_getAccount` / `olesia_signPsbt`. **Testnet only.**
- `infra/cloudflare/olesia-swap-worker.js` + `docs/SWAP_CONNECT_SETUP.md` — recommend a **subdomain
  `swap.olesia.io`** (NOT `olesia.io/swap` — the swap page imports root-relative `./eth-wallet.js`,
  which a path route would break). Worker proxies swap.olesia.io→swap server and injects the
  provider.
- Tests: `test/htlc_sign.test.mjs`, `test/connect.test.mjs`.

**Deploy TODO (when the swap agent is ready):** (1) `node connect/build.mjs`, stage
`connect/olesia-provider.js` → `web/publish/olesia-provider.js` and `connect/dist/*` →
`web/publish/connect/`, deploy `olesia-wallet`; (2) `cloudflared` ingress
`swap-origin.olesia.io`→`127.0.0.1:8975`; (3) deploy the Worker on `swap.olesia.io/*`. Until then the
swap page's manual PSBT-paste fallback works with zero infra.

**Swap lifecycle (for the UI + testing):** `OFFERED→ACCEPTED→A_LOCK_CONFIRMED→B_LOCK_*→(redeem)→
COMPLETED`, branches `REFUND_WAIT/COUNTERPARTY_TIMEOUT/UNCERTAIN/REORG_HOLD`. API: `/quote→/swap→
/swap/:id(/intents|/psbt/:purpose|/signed-tx|/refund)`.

**Adversarial test plan (paused, operator: "really go all out"):** attack the M8 verifier boundary
with mutated bytes; exactly-once/double-pay on `/signed-tx`; HTLC edges (wrong/no secret, early
refund, redeem/refund races); the connect signer (foreign key, non-HTLC, tampered witnessScript,
mainnet, origin spoof); concurrency/reorg/quote-expiry. Black-box the API + contract only.

**Funding done:** 100 tBTC (50 each) sent+confirmed to the swap test addresses
`tb1qd68za23hy7xkjwtql6346dfufnlt4awem2gta2` (LP) and `tb1q2k265znevpdwnv67nykfzhysprvatyg7hhnqct`
(user); + 10 sBTC (signet) to `tb1qyr7yaw3gcfde9wsgyuwvjrul97tnshhe7zux8h`.

**Swap UI:** a clickable prototype was built (Direction 1 "Sound Money Minimal" — Uniswap-simple
card + honest named-stepper progress + refund path + two-wallet connect). Saved at scratchpad
`olesia_swap.html`; a full UX research brief (Uniswap/1inch/CowSwap/Jupiter/THORSwap/Chainflip/Squid/
Boltz + copy + 3 visual directions) is in the session history. The Artifact publish was blocked by a
transient hosting outage — retry when resuming. Operator chose "prototype-first, then productionize."

---

## 9. Infrastructure

**systemd services (all active):**
- `bitcoind.service` (mainnet), `bitcoind-signet`, `bitcoind-testnet3`, `bitcoind-testnet4`
  (pruned, `prune=5000`, cookie auth; configs in `infra/systemd/`). Datadirs `/var/lib/bitcoind-*`.
- `olesia-faucet` (:8790), `olesia-faucet-dashboard` (:8793), `olesia-nostr-bot`,
  `olesia-broadcast` (api.olesia.io). Restart via `sudo -n systemctl restart <svc>` (passwordless
  sudo works for these).

**Cron (`crontab -l`):** `30 3 * * * cd /home/faucet/BTC_Wallet && ./p2pk-explorer/update.sh` (builds
explorer data + redeploys `olesia-landing`, reading `.secrets/cloudflare.env`). The other cron lines
belong to the unrelated trading projects.

**Cloudflare:** Pages projects **`olesia-wallet`** (app.olesia.io), **`olesia-landing`** (olesia.io),
**`alea-wallet`** (offline.olesia.io), **`olesia-signer`** (olesia-signer.pages.dev; sign.olesia.io
pending). A **Cloudflare Tunnel** maps faucet/api subdomains to localhost ports (`~/.cloudflared`).
The **only** Cloudflare API-token consumer on the box is the p2pk cron + manual deploys, both reading
`.secrets/cloudflare.env` (a single minimal **Pages:Edit** token — the old over-privileged tokens
were deleted 2026-08-16).

**Secrets** (`packages/bitcoin/.secrets/`, gitignored, 0600 — NEVER commit): `faucet.json` (the
testnet payout mnemonic), `cloudflare.env` (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`),
`turnstile.json`, `internal.json` (faucet internal token), `telegram.json`, `nostr.json`,
`signet/testnet3/testnet4.json`, `faucet-claims.db` (+ WAL/shm + timestamped pre-migration backups),
`breaker-state.json`, `faucet-telemetry.json`, heartbeats, `android-signing.json` +
`olesia-android.keystore` (mobile). **No exchange/mainnet-spend keys exist; the faucet is
testnet-only and mainnet payout is hard-disabled.**

---

## 10. Deploy process

```
cd /home/faucet/BTC_Wallet/packages/bitcoin
set -a; . .secrets/cloudflare.env; set +a          # loads token + account id (never echo them)
# WALLET (stage a clean flat folder first):
node web/build.mjs
rm -rf web/publish && mkdir -p web/publish
cp web/index.html web/_headers web/publish/
cp web/pwa/manifest.webmanifest web/pwa/icon-192.png web/pwa/icon-512.png web/pwa/icon-maskable-512.png web/publish/
[ -d web/pwa/.well-known ] && cp -r web/pwa/.well-known web/publish/
# (for the swap connect: also node connect/build.mjs; cp connect/olesia-provider.js web/publish/ ; mkdir -p web/publish/connect && cp connect/dist/* web/publish/connect/)
npx wrangler pages deploy web/publish --project-name=olesia-wallet --branch=main
# verify:  cd /home/faucet/BTC_Wallet && node tools/verify-bundle.mjs production   # expects ✓ wallet match
```
Signer: `node signer/build.mjs` → `npx wrangler pages deploy signer/dist --project-name=olesia-signer
--branch=main`. Landing/coldgen follow the same pattern (projects `olesia-landing` / `alea-wallet`).
`--branch=main` is what makes it **production** — don't omit it.

---

## 11. Current state & pending items

- ✅ Kimi audit fully remediated; wallet **redeployed** to app.olesia.io (served == repo build,
  verified); faucet **restarted** on the new code; Cloudflare token **rotated** to minimal scope.
- ⬜ **Push** the unpushed swap-connect commit (`4042803`) when the operator says so.
- ⬜ **Swap connect deploy** (§8 TODO) — gated on the swap agent being ready; operator said "I'll
  wait till the other agent is sorted, then we'll work together."
- ⬜ **Swap UI prototype** — retry the Artifact publish (was a hosting outage); iterate with operator.
- ⬜ **Adversarial swap testing** — ready to run (funding confirmed); paused pending the swap agent.
- ⬜ `sign.olesia.io` custom domain for the signer; **dismiss** the GitHub secret-scanning alert
  (fake test token, false positive); Mac-side `npm install && npx cap sync ios` for Capacitor 7.
- ⬜ **Pure-dice "trustless & verifiable" seed mode** (SeedSigner-standard: `SHA-256(dice only)`, 99
  rolls, reproducible, on the offline generator) — designed, not built (see §12).
- ⬜ 9/10 program remainders: P4 differential/fuzz, P5 mainnet forward-test; Quick Wallet build.

---

## 12. Key rules & gotchas (read these)

1. **Honest framing** — never "secure/audited/verified". No third-party human audit exists.
2. **Testnet-first; mainnet payout is hard-disabled.** Never write code that signs/broadcasts with
   real-value keys without the operator's explicit, per-instance direction. No exchange keys on box.
3. **Don't modify the swap engine tree** (`/home/faucet/olesia-atomic`) — the contract file is the
   whole boundary.
4. **Secrets never leave `.secrets/`** (gitignored). When handling the Cloudflare token, source the
   env file — never print it (a masking bug once leaked one; it was rotated + deleted).
5. **Faucet single-big-coin lesson** — §5 gotcha; verify sends via esplora tx status.
6. **Crypto is @noble/@scure only** in the wallet tree; hand-rolled BIP-143 follows the tested
   `p2pk_fund.js` pattern; prove new signing against an independent oracle (Bitcoin Core, or the
   swap engine's `verifySignedAgainstIntent`).
7. **Dice/entropy:** current `generateFrom` = `SHA-256(CSPRNG ‖ dice)` — strong if EITHER source is,
   but NOT reproducible/verifiable and enforces no roll minimum. A pure-dice mode
   (`SHA-256(dice only)`, 99 rolls, on the cold generator) would match SeedSigner's trustless value.

---

## 13. Memory & continuity

Persistent agent memory lives at
`/home/faucet/.claude/projects/-home-faucet-bipaudit/memory/` (index `MEMORY.md`). Relevant files:
`olesia-security-remediation`, `olesia-faucet-redteam`, `olesia-9-10-program`, `olesia-faucet-nostr`,
`olesia-p2pk-explorer`, `olesia-ios-app`, `olesia-swap`. These are point-in-time notes — verify
against current code before relying on file:line citations.

**Working dir for sessions has been `/home/faucet/bipaudit` (a separate audit sandbox), but all
Olesia work is in `/home/faucet/BTC_Wallet`.** Start there.

---

*Handover written 2026-08-18. The platform is in a clean, deployed, tested state. Good luck — and
be as careful with real value as this project has tried to be.*
