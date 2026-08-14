# P1 — Mainnet Key Custody: watch-only by default + air-gap/hardware signing (DESIGN)

Goal of the 9/10 program's highest-leverage change: **the hot browser wallet must not hold
mainnet private keys by default.** A browser app is exposed to XSS, malicious extensions,
supply-chain swaps and device compromise; no amount of testing removes that for a hot key.
For mainnet we move signing OFF the hot surface. Testnet keeps its current low-stakes
convenience (no real value). This is design-only — implementation is gated and separately
reviewed, same discipline as the RT/NODE work.

## LOCKED DECISIONS (2026-08-14, supersede the open questions at the bottom)
1. **Do NOT remove the hot wallet.** Keep it usable (incl. mainnet), but make the OFFLINE path
   excellent and the safer choice unmissable. Model: informed consent + steering, like
   Sparrow/Electrum — great software, the user picks custody, the app makes the safe choice
   obvious. Honest framing: the PLATFORM can be 9/10 (excellent air-gap option + clear guidance +
   the rest of the assurance program); an individual's safety still depends on following it.
2. **Signing path: air-gap first (no hardware yet).**
3. **PSBT transport: file + animated QR (BC-UR).**
4. **Offline signer: a SEPARATE, offline-only signer app** (distinct from the cold generator).
   offline.olesia.io stays generate/backup-only; a new hardened, network-less signer app does
   PSBT import → verify → sign → export.
5. **Steer threshold: ~$100** (and any "savings/long-term" intent) → the hot wallet's Send screen
   recommends + links the offline flow. Threshold configurable; tiers can be added later.

## Guiding principle
```
HOT WALLET (app.olesia.io)              OFFLINE SIGNER (new, network-less app)
  mainnet: build UNSIGNED PSBT            import unsigned PSBT (file / BC-UR QR)
  (watch-only xpub, or a warned hot         verify ownership from account xpub
   seed for small amounts)                  WYSIWYS review
  >~$100 / savings -> steer to offline      sign with the seed (held ONLY here)
  import SIGNED PSBT, re-verify + WYSIWYS   export signed PSBT (file / BC-UR QR)
  broadcast via OWN mainnet node
TESTNET: unchanged (no real value; keep the convenience)
```
For real value the seed lives only on the offline signer; the hot wallet stays a convenience
that clearly tells users when to step up to the offline flow.

## Current state (grounded in code — what we already have)
- **Watch-only:** `resolveWallet`/`watchOnly(xpub)` derive addresses from an account xpub and
  refuse to sign ("watch-only (xpub) cannot sign — use the air-gap tools").
- **Air-gap PSBT flow (p2wpkh/native SegWit):** `prepareUnsigned` (build unsigned PSBT from an
  xpub), `signUnsigned`/`signPSBTOffline` (sign with the seed, offline), `broadcastSigned`
  (broadcast a fully-signed PSBT). `describePSBT` verifies ownership **derived from the account
  xpub**, never from PSBT metadata — the right trust model.
- **WYSIWYS / verify-before-sign / freeze-broadcast** already exist (RT-2/RT-5 era): built txid
  is authoritative, returned txid must match, exact bytes are broadcast.
- **Own mainnet node** exists (pruned Core) — broadcast target for the signed tx (ties to P5).
- **Gaps:** (a) mainnet does NOT default to watch-only — a user can still load a mainnet seed
  into the hot wallet and sign there; (b) the air-gap flow is opt-in and p2wpkh-only; (c) **no
  hardware-wallet path**; (d) mainnet broadcast still uses an external explorer.

## Target architecture — the three mainnet signing paths
1. **Air-gap (default, no new hardware):** app.olesia.io (watch-only xpub) builds an unsigned
   PSBT → user transfers it to an OFFLINE signer that holds the seed (offline.olesia.io loaded
   air-gapped, or a saved verified copy) → signer verifies + signs → signed PSBT returns to the
   hot wallet → hot wallet re-verifies ownership (`describePSBT`) + WYSIWYS → broadcast via own
   node. Transfer via file download/upload AND animated QR (BC-UR) so no cable is needed.
2. **Hardware wallet — Coldcard (PSBT, closest fit):** same flow, but the signer is a Coldcard
   reading/writing the PSBT via microSD or QR. Reuses the exact PSBT pipeline; mostly UI +
   PSBT-format compatibility (BIP-174 base64/file, BC-UR QR). Recommended first hardware target.
3. **Hardware wallet — Ledger/Trezor via WebHID (later, larger):** in-browser USB signing.
   Bigger surface + per-vendor quirks; a separate follow-on, not part of P1's core.

## Gated implementation plan (each step = its own reviewed change + tests, STOP between)
- **P1.a — NEW offline signer app (the core build).** A hardened, network-less web app (own
  Pages project, e.g. `sign.olesia.io`; CSP `connect-src 'none'`, reproducible build like the
  cold generator). Flow: enter/restore seed offline → import UNSIGNED PSBT (file + BC-UR QR) →
  `describePSBT` ownership verification (derived from the account xpub, never PSBT metadata) →
  WYSIWYS review → `signPSBTOffline`/`signUnsigned` → export SIGNED PSBT (file + BC-UR QR).
  Reuses the audited `packages/bitcoin` engine; new = the offline front-end + PSBT file/QR I/O.
- **P1.b — Hot wallet watch-only + air-gap send.** Mainnet: build UNSIGNED PSBT from an xpub
  (`prepareUnsigned`), export to the signer (file/QR), import the SIGNED PSBT, re-verify
  ownership + WYSIWYS, broadcast. Keep a warned hot-seed path for small amounts (see P1.c).
- **P1.c — Education + graduated friction.** Unmissable hot-wallet risk explainer; at ~$100+ (or
  savings/long-term intent) the Send screen recommends + links the offline flow. Threshold
  configurable.
- **P1.d — Own-node mainnet broadcast.** Extend NODE-1's fail-closed own-node broadcaster to
  mainnet (gated, like the testnet cutover) so signed mainnet txs broadcast via your Core node.
- **P1.e — Docs + tests + differential/fuzz on the PSBT round-trip.** Round-trip vectors,
  ownership-accept/reject tests, tamper tests, BC-UR encode/decode tests, Core differential
  check of the final tx, user-facing security model doc. (Hardware/Coldcard = deferred follow-on.)

## Component to add: BC-UR animated QR
Need a BIP-174 PSBT ⇄ BC-UR encoder/decoder for animated QR (e.g. a vetted `bc-ur` lib or a
small audited implementation). Used by both the hot wallet (export unsigned / import signed) and
the signer (import unsigned / export signed). Pin + review the dependency (ties to P2).

## Test plan
- Round-trip: watch-only build → offline sign → verify → broadcast produces exactly the intended
  tx; `describePSBT` correctly accepts own inputs/outputs and REJECTS foreign ones (ownership
  from xpub, not metadata). Differential-check the final tx against your own Bitcoin Core
  (`testmempoolaccept`/`decoderawtransaction`) — ties to P3/P4.
- Negative: a mainnet seed cannot be used to sign in the hot wallet under the default policy; a
  tampered PSBT (changed output/amount/change) is caught at verification/WYSIWYS.
- Fuzz PSBT parsing/verification (ties to P4).

## What this buys (threat-model delta)
Removes the entire class of "hot browser compromise steals mainnet key": XSS, extension,
served-JS swap, device malware. The signing device (offline app / hardware) is the only thing
that touches the mainnet seed, and it's air-gapped. Combined with P2 (verifiable delivery) and
own-node broadcast, mainnet no longer trusts the browser surface OR an external explorer.

## P1 exit criteria (contributes to the 9/10)
Mainnet is watch-only by default in app.olesia.io · mainnet spends are unsigned-PSBT only ·
ownership verification is mandatory and derived from the xpub · at least one off-hot signing
path (air-gap) is documented + tested end-to-end, hardware (Coldcard) supported · signed mainnet
tx broadcasts via your own node · user-facing security doc published.

## Decisions I need from you before P1.1
1. **Hot mainnet seed:** REMOVE the hot-wallet mainnet-seed signing path entirely, or keep it as
   a hard-gated "advanced, small amounts only, not recommended" mode? (Recommend: default
   watch-only; keep hot-seed only behind an explicit advanced toggle, or remove — your call.)
2. **First hardware target:** Coldcard (PSBT/SD/QR — closest, recommended) now, Ledger/Trezor
   (WebHID) later? Do you have a Coldcard (or other) to round-trip test?
3. **PSBT transport:** file + animated QR (BC-UR) both, or start with file only?
4. **Offline signer:** is offline.olesia.io already able to sign an imported PSBT, or do we build
   that signing capability into it as part of P1.3? (I'll verify the offline app's current
   abilities before P1.3.)
