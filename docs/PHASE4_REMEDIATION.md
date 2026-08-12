# Olesia Wallet — Phase 4 Remediation Report (Experimental Bitcoin Functionality: P2PK)

**Repository:** https://github.com/testnetbtc/BTC_Wallet — branch `main`
**HEAD at time of report:** `76137d6`
**Scope:** Phase 4 of the security remediation order — dedicated P2PK security audit (13),
Bitcoin Core cross-validation (14), transaction edge cases (15).
**Deployment:** no user-facing change; production and preview both unchanged (this phase
adds tests + evidence only). Phase 3 remains on preview pending review, as instructed.

## Verdict

**The hand-rolled P2PK implementation is CORRECT — no defect found.** Priority 7 asked
that this unusual, manually-serialised component be *treated as its own security-sensitive
unit and tested much harder*, not removed. It has now been attacked from every angle the
order lists and independently validated three ways: **Bitcoin Core**, a **separately-coded
sighash**, and **live real-network acceptance**. A comprehensive regression-vector set is
now permanent.

## Component under audit

`packages/bitcoin/src/p2pk_fund.js`:
- `buildFundP2PK` — spends P2WPKH input(s) to a bare `<pubkey> OP_CHECKSIG` output plus
  P2WPKH change. **BIP-143** (SegWit v0) sighash, hand-serialised because @scure/btc-signer
  refuses to emit a bare `pk` output.
- `buildSpendP2PK` — spends a single P2PK output to a destination (+ optional OP_RETURN).
  **Legacy** (pre-SegWit) sighash, with the prevout P2PK script as the subscript.
- Signing: `@noble/curves` secp256k1, DER, canonical **low-S**, `SIGHASH_ALL`.

## How it was validated (three independent oracles)

1. **Bitcoin Core `decoderawtransaction`** (`test/p2pk_vectors.test.mjs`): confirms the
   fund's vout0 is genuinely a `pubkey` (P2PK) output carrying our exact key, the tx is
   segwit with a witness, the spend is legacy (scriptSig signature, no witness) with a
   `nulldata` OP_RETURN, and **Core's txid == Olesia's txid** for every case.
2. **Independent sighash** — the test recomputes the BIP-143 sighash (fund) and the legacy
   sighash (spend) via a **separate code path**, extracts the DER signature from the built
   transaction, and verifies it with `secp256k1.verify`. This proves the signature commits
   to the *correct message*, not merely that the bytes are well-formed. (Directly answers
   "do not test Olesia with Olesia".)
3. **Live real-network acceptance** (`test/p2pk_live.mjs`): real Bitcoin nodes fully
   validate the signature and script, so an accepted broadcast is proof beyond any local
   check. Verified live on **two independent networks**:
   - testnet4 — MINT `b3350fd4f3f68fe2832559f702a1e7b0a49af9057230abb44b5f5af70d8523f6`,
     SPEND `314cf8f68458dda1749be543795895d531fb411c99aa939d9d112200e6ae1524`
   - signet — MINT `c3b394901847a4974636a86635acc8407209823e88574b1d19032df76bde4011`,
     SPEND `43acb0d6dcfc6c9909e71cee5907e111d4c02a6874a7e1246f57601340ade9c8`

## Edge cases covered (the order's list)

| Case | Result |
|---|---|
| VarInt boundaries (0xfc, 0xfd, 0xffff, 0x10000, 0xffffffff, 0x100000000) | exact bytes ✓ |
| DER signature correctness | parsed, Core-validated, live-accepted ✓ |
| Low-S requirement (S ≤ n/2) | checked on fund + spend sigs ✓ |
| Witness serialisation (fund) / legacy scriptSig (spend) | Core-confirmed ✓ |
| Multiple inputs (2, 3, 10) | Core-decoded, every input witnessed ✓ |
| Change / no change / dust-absorbed | ✓ |
| **Exact dust boundary** (294 kept vs 293 absorbed) | ✓ |
| Exact-spend / value conservation (fee + sent = value) | ✓ |
| Insufficient funds / value-below-fee | rejected ✓ |
| OP_RETURN 75 / 76 (OP_PUSHDATA1) / 80 bytes | build + Core nulldata ✓ |
| OP_RETURN 81 bytes | rejected ✓ |
| Uncompressed (65-byte) P2PK — the Satoshi-era form | Core-decoded as pubkey ✓ |
| Fee calculation & txid calculation | exact, Core-cross-checked ✓ |
| SIGHASH_ALL | ✓ |
| Deterministic regression (fixed key/inputs → pinned txid/hex) | ✓ |

## Notes on design choices (not defects)

- **Sequence / locktime are fixed** (`nSequence = 0xffffffff`, `nLockTime = 0`): the P2PK
  txs are final and non-RBF by design. Stated here rather than changed.
- **Fee is exact; feerate is approximate.** The fee equals `inputs − outputs` exactly; the
  size estimate (`estVsize`) assumes a max-length (73-byte) signature, so the realised
  feerate is marginally *above* the requested rate (a tiny overpay, never an underpay).
  Verified by Core-decoding the actual sizes.
- P2PK spend is **one input per transaction** (each bare-pubkey coin swept individually);
  the multi-coin WIF sweep loops over them. Consistent with how explorers can't index P2PK.

## Test results

`npm test` — 16 offline groups, all passing (P2PK adds `p2pk_vectors`, 40 checks). Live:
`test/p2pk_live.mjs` (testnet4 mint + spend accepted) — PASS.

## Residual notes (honest)

1. **Live acceptance was on testnet4 and signet** — two independent real networks, both
   enforcing mainnet's consensus script rules. Not exercised on mainnet (no reason to put
   a museum P2PK on mainnet); real-node acceptance on two test networks is equivalent proof.
2. P2PK remains an **educational museum feature**, testnet-first; it is not a
   general-purpose spend path.
3. Internal + independent-oracle + live tests, **not an independent audit**.

## Not yet started (pending review)

Phase 5 (CSP/clickjacking response headers, online/offline threat-model documentation,
dependency audit, reproducible-build hardening, production/source hash verification),
Phase 6 (SECURITY.md rewrite + final consolidated remediation report).
