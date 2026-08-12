# Olesia Wallet — Phase 3 Remediation Report (Wallet Architecture)

**Repository:** https://github.com/testnetbtc/BTC_Wallet — branch `main`
**HEAD at time of report:** `adeb88c`
**Scope:** Phase 3 of the security remediation order — HD receive/change chains (8),
address discovery / gap limit (9), extended public key handling (10), output
descriptors (11), wrong-network protection (12).
**Deployment:** live on `preview` (preview.olesia-wallet.pages.dev); production
(app.olesia.io) unchanged pending review.

Investigated before any change. The complete offline suite is now **15 groups, all
passing**, plus a **live** deterministic-recovery test on testnet4 and **Bitcoin Core**
cross-validation of descriptors and multi-input transactions.

## Finding summary

| ID | Severity | Finding | Original | Final | Commit |
|----|----------|---------|----------|-------|--------|
| P5-8 | MED | Single-address; change returned to the receive address | Confirmed | Fixed | `adeb88c` |
| P5-9 | MED | No address discovery; funds off index 0 invisible | Confirmed | Fixed | `adeb88c` |
| P6-10 | MED | testnet emitted `xpub` not `tpub` | Confirmed (bug) | Fixed | `5be8611` |
| P6-11 | MED | No output descriptors | Confirmed | Fixed | `5be8611` |
| P12 | MED | Wrong-network rejected only via a cryptic error | Partial | Fixed | `adeb88c` |

## The recovery guarantee (the operator's hard requirement)

> Recovery from mnemonic + optional passphrase alone must rediscover all wallet
> funds without relying on browser-local metadata.

This is satisfied and **proven live** (`test/recovery_live.mjs`, testnet4). A throwaway
seed was funded at receive indexes **0,1,2,5,19,20,21** and change indexes **0,3**;
`discoverAccount`, given only the seed, **rediscovered every one**. A subsequent HD send
created change on change-chain index 4, which was then **rediscovered from the seed
alone**. Backward-compatibility verified: a pre-Phase-3 single-address wallet (funds only
at 0/0) is still fully discovered and spendable across all script types.

**Sequencing note:** discovery was implemented and proven *before* change/receive
rotation was switched on, so no funds ever became invisible. An address is treated as
"used" if it has *ever* received (esplora `tx_count`), not merely if it has a current
balance — otherwise a spent-empty address could falsely trip the gap limit and hide
funds beyond it.

## Detail

### P5-8 / P5-9 — HD chains + discovery
- `deriveKey`/`deriveScript` gained a `chain` parameter (0 = external/receive, 1 =
  internal/change; default 0 preserves every existing address — verified byte-identical).
- `discoverAccount()` walks both chains with a gap limit (default 20) in parallel windows
  and returns every used address with balance/UTXOs, plus `nextReceive`/`nextChange`.
- `prepareSendHD()` + `buildSignedTxMulti()`/`buildSweepTxMulti()` spend across all
  discovered UTXOs (per-input keys) and send change to the **next unused change address**.
- UI: balance/account views use discovery; the account page rotates the shown receive
  address; the confirm sheet marks the change-chain output as change.
- **Gap-limit is a documented limitation:** a fund isolated more than `gap` indexes past
  the last used address is not found at the default gap (test shows index 50 missed at
  gap 20, found at gap 40). This is standard BIP-44 behaviour, stated honestly.

### P6-10 / P6-11 — tpub + descriptors (Bitcoin Core cross-checked)
- `accountXpub` now serialises with per-network version bytes: **tpub** on test networks,
  **xpub** on mainnet (was xpub everywhere). `parseExtendedKey()` accepts either prefix,
  fixing a regression where `fromExtendedKey` defaulted to mainnet bytes and threw
  "Version mismatch" on a tpub during watch-only import.
- `descriptor.js` emits BIP-84 receive/change descriptors
  `wpkh([fp/84h/coinh/0h]xpub/0/*)#cksum` using Bitcoin Core's descriptor-checksum
  algorithm, exposed in Settings as the watch-only interchange format.
- **Cross-checked against Bitcoin Core** (`test/descriptor.test.mjs`): our checksum ==
  `getdescriptorinfo`, and `deriveaddresses` == Olesia for **both chains, indexes 0..25**.

### P12 — wrong-network protection
- `assertAddressNetwork()` rejects a cross-network address with a clear message, wired
  into every recipient and sweep destination in all builders. `test/wrong_network.test.mjs`
  proves rejection for all four formats (p2wpkh/p2tr/p2sh-p2wpkh/p2pkh), both directions.

## Bitcoin Core cross-validation

- Descriptors: checksum == `getdescriptorinfo`; `deriveaddresses` == Olesia, both chains.
- A live multi-input HD transaction (3 inputs across addresses) decoded on the full node:
  identical vin/vout/txid.

## Test results

`npm test` — 15 groups, all passing:
```
TX · PSBT · SCRIPT-TYPES · P2PK · VAULT · WIF · DESCRIPTOR · FEE · FREEZE ·
PSBT-VERIFY · LEAK · BACKUP · PASSPHRASE · WRONG-NETWORK · UI
```
Live (not in the default suite; needs network + faucet): `test/recovery_live.mjs`
(deterministic recovery + gap-limit) — PASS.

## Residual notes (honest)

1. **Gap limit** is a scan-window limitation: funds isolated beyond the gap need a manual
   rescan at a larger gap. Documented and demonstrated.
2. **Routine UI refresh** runs full discovery for the active script type and a cheap
   index-0 read for the others (to bound API calls); a non-active account is fully
   discovered when opened. Recovery is never dependent on this — `discoverAccount` from
   the seed is the source of truth.
3. Watch-only descriptors/discovery cover **BIP-84 native SegWit** (what the wallet
   builds). Other script types derive per-type but are not part of the descriptor export.
4. Internal reviews and automated + live adversarial tests, **not an independent audit**.

## Not yet started (pending review)

Phase 4 (dedicated P2PK audit + Bitcoin Core cross-validation + transaction edge cases),
Phase 5 (CSP/clickjacking headers, online/offline threat-model docs, dependency audit,
reproducible-build hardening, production/source hash verification), Phase 6 (SECURITY.md
rewrite + final remediation report).
