# Olesia Wallet — Phase 1 Remediation Report (Transaction Authorisation)

**Repository:** https://github.com/testnetbtc/BTC_Wallet — branch `main`
**HEAD at time of report:** `d99858f6cf40ef2a891b2be47dceb05f06f046e4`
**Scope:** Phase 1 of the security remediation order — P1 (offline PSBT verification),
P2 (build-once / broadcast-same-transaction), P4 (fee safety).
**Deployment:** live on the `preview` deployment (preview.olesia-wallet.pages.dev);
production (app.olesia.io) is unchanged pending review.

All three findings were investigated against HEAD **before** any code change and are
**CONFIRMED** (none were already-fixed or not-reproducible). Each fix is a separate
commit; the complete test suite (10 groups) passes; the transaction decoder was
cross-validated against an independent Bitcoin Core node.

## Finding summary

| ID | Severity | Finding | Original | Final | Commit | Evidence |
|----|----------|---------|----------|-------|--------|----------|
| P1 | HIGH | Offline signer signs without verifying contents | Confirmed | Fixed | `d99858f` | `test/psbt_verify.test.mjs` (22 checks) |
| P2 | HIGH | Transaction rebuilt after user confirmation | Confirmed | Fixed | `a8a506d` | `test/freeze.test.mjs` + `test/ui.test.mjs` regression |
| P4 | MED/HIGH | No fee ceiling; malicious fee can reach signing | Confirmed | Fixed | `434c705` | `test/fee.test.mjs` (24 checks) |

---

## P1 — Offline PSBT signer signed blindly  [CONFIRMED → FIXED] (commit `d99858f`)

**Original.** `signPSBTOffline()` in `packages/bitcoin/src/psbt.js` did
`fromPSBT → sign → finalize` with zero decoding, ownership checking, or display; the
UI (`web/ui.js` `#signbtn`) signed a pasted PSBT immediately.

**Attack.** A compromised online/watch-only machine hands the air-gapped signer a PSBT
paying an attacker, and it signs without ever showing the destination.

**Fix.** New `describePSBT()` treats the PSBT and its creator as untrusted. It
independently re-derives the wallet's own receive (chain 0) and change (chain 1)
scripts from the account xpub (gap limit 20) and classifies every input (mine/foreign)
and every output (verified-change / external / OP_RETURN) by comparing **raw scripts**,
never trusting `bip32Derivation` or any creator-supplied metadata. The fee is computed
independently as `inputs − outputs` (null if input amounts are absent).
`signUnsigned()` in `src/send.js` now **refuses** to sign when:

- no input belongs to the wallet;
- ANY input is foreign (a single-sig wallet must never co-sign foreign inputs);
- the fee cannot be independently verified;
- outputs exceed inputs;
- the fee exceeds 20% of inputs.

The UI shows a full review sheet (each input mine/foreign with derivation path; external
payments vs cryptographically-verified change; independently-computed fee) and only
enables signing after explicit confirmation.

**Evidence.** `test/psbt_verify.test.mjs`, 22 adversarial checks, all passing — the core
attack (a 950,000-sat output to an attacker is reported EXTERNAL even when metadata
claims it is change), forged-change metadata, foreign input, wrong network (testnet PSBT
vs mainnet wallet), missing input amounts (fee unknowable → refuse), unknown/other
script type, multiple inputs/outputs, oversized fee, malformed PSBT, and confirmation
that a legitimate PSBT still signs.

---

## P2 — Transaction rebuilt after user confirmation  [CONFIRMED → FIXED] (commit `a8a506d`)

**Original.** `runSend()` in `web/ui.js` built a dry-run for the confirmation sheet,
then after the user confirmed called the builder **again** — re-fetching UTXOs,
re-fetching the fee estimate (Auto mode), re-selecting coins, and re-signing a
**different** transaction — and broadcast that. The user approved transaction A;
transaction B was broadcast. The WIF-sweep path had the same shape.

**Fix — enforced as a stated code invariant:** *build once, decode, display, confirm,
broadcast the same bytes.* The engine gained `decodeRawTx()` (renders the confirmation
from the transaction bytes themselves — the transaction is the source of truth, not UI
form values) and `broadcastRaw()` (broadcasts exact bytes and aborts if the network
reports a different txid than the bytes' own txid). `runSend()` now builds once, freezes
the signed hex, generates the confirmation sheet by decoding those exact bytes (change
vs external determined by comparing to the wallet's own derived address), and after
confirmation broadcasts the frozen hex; abnormal-fee rows (fee > 10% of the amount sent,
or rate > 200 sat/vB) are surfaced on the same sheet. WIF sweep fixed identically.

**Evidence.** `test/freeze.test.mjs` (decode fidelity + broadcast txid cross-check) and a
regression in `test/ui.test.mjs` that drives the **real** confirmation sheet in a
headless DOM with a stubbed engine and proves the engine builds **exactly once** and that
a fee/UTXO change injected **after** the confirmation screen cannot alter the broadcast
bytes (broadcast receives byte-for-byte the pre-confirmation hex).

---

## P4 — No fee ceiling; malicious fee could reach signing  [CONFIRMED → FIXED] (commit `434c705`)

**Original.** `getFeeRate()` in `src/esplora.js` was `Math.max(1, Math.ceil(f['6'] ?? 2))`
— a floor only, no upper bound and no finiteness check, so NaN/Infinity/absurd values
from a malicious or broken Esplora response propagated into transaction building.

**Fix.** `getFeeRate()` now rejects non-finite values (falls back to 2 sat/vB) and clamps
to `[1, 1000]` sat/vB (`MAX_ESTIMATED_FEERATE`); a new `assertFeeRate()` in `src/tx.js`
is a hard boundary that refuses to **build** any transaction with a non-finite, `< 1`, or
`> 5000` sat/vB (`MAX_FEERATE`) rate, wired into all five builders (`buildSignedTx`,
`buildSweepTx`, `buildUnsignedPSBT`, `buildFundP2PK`, `buildSpendP2PK`); abnormal-fee
warnings appear on the confirmation sheet, with deliberate override still possible via a
manually-typed rate under the hard cap.

**Evidence.** `test/fee.test.mjs`, 24 checks against `0, -1, NaN string, null, 1e6, 1000,
100, missing key, malformed JSON, HTTP 500`, plus proof the guard is wired into the
builders.

---

## Independent Bitcoin Core cross-validation

A real mainnet transaction (1-in, OP_RETURN "core xcheck" + payment + change, 5 sat/vB)
was decoded with our `decodeRawTx()` and with `bitcoin-cli decoderawtransaction` on a
full node:

```
txid    360980b2ff5a98db8d191afd666cf1656a1821e944df66b94f0222164016c355  (ours == Core)
vsize   163                                                                (ours == Core)
vout 0  OP_RETURN  636f72652078636865636b  ("core xcheck")
vout 1  change     399185 sat
vout 2  payment    600000 sat
```

Confirming the confirmation-screen decoder is faithful to the bytes an independent
implementation sees. The existing script-type suite also decodes every built transaction
through Bitcoin Core.

## Test results

`npm test` runs 10 groups, all passing:

```
TX ✓ · PSBT ✓ · SCRIPT-TYPES ✓ · P2PK ✓ · VAULT ✓ · WIF ✓
FEE ✓ (P4) · FREEZE ✓ (P2) · PSBT-VERIFY ✓ (P1) · UI ✓ (DOM regressions incl. P2 freeze proof)
```

## Residual notes (stated honestly, not resolved in Phase 1)

1. The PSBT verifier assumes the standard **BIP84 native-SegWit** account, which is what
   the wallet builds for the air-gap flow; watch-only signing for other script types is
   not part of that flow today.
2. The P2PK lab and multi-transaction WIF sweep of bare-pubkey UTXOs use deterministic
   per-outpoint signing (RFC-6979), so a rebuild produces identical bytes and they are
   not affected by the P2 class of issue; they were reviewed and left unchanged rather
   than modified.
3. These are internal reviews and automated adversarial tests, **not an independent
   audit**.

## Not yet started (pending review of Phase 1)

Phases 2–6 of the order: vault/PIN entropy, secret-leakage audit, backup re-audit, HD
receive/change chains and gap-limit recovery, descriptor/xpub interoperability, dedicated
P2PK vectors, CSP response headers, threat-model documentation, dependency audit,
reproducible-build hardening, and the SECURITY.md rewrite / final remediation report.
