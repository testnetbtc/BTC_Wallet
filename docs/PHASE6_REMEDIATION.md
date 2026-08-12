# Olesia Wallet — Consolidated Remediation Report (Phases 1–6)

**Repository:** https://github.com/testnetbtc/BTC_Wallet — branch `main`
**Scope:** the final documentation & closure pass. Phase 6 introduced **no wallet
behaviour change** — it rewrote `SECURITY.md`, produced this consolidated report, and added
the production release checklist. All remediation work was completed in Phases 1–5.
**Deployment status:** wallet + cold generator + landing are on **preview**; production is
**untouched**, pending the operator's final review before a coordinated promotion.

> This project is not described as "secure", "fully audited", or "formally verified". The
> claim is: the findings from an internal static review have been **remediated and tested to
> the scope documented here**, with the residual limitations recorded explicitly.

## Finding tracker (original review → Phase → status)

Severity is the original assessment. "Status" is the current state; "Evidence" cites the
permanent tests/artifacts.

| # | Finding | Sev | Phase | Commit | Evidence | Status | Residual |
|---|---|---|---|---|---|---|---|
| P1 | Offline PSBT signer signed without verifying contents | HIGH | 1 | `d99858f` | `psbt_verify.test.mjs` (22, incl. core attack) + Core decode | **Remediated** | verifier covers BIP-84 watch-only |
| P2 | Transaction rebuilt after user confirmation | HIGH | 1 | `a8a506d` | `freeze.test.mjs` + `ui.test.mjs` freeze regression | **Remediated** | — |
| P4 | No fee ceiling; malicious fee could reach signing | MED/HIGH | 1 | `434c705` | `fee.test.mjs` (24 adversarial) | **Remediated** | — |
| P3 | Weak PIN as sole entropy over a mainnet seed | HIGH | 2 | `199ded5` | `vault.test.mjs` (+14) + scrypt benchmark | **Remediated** | WebAuthn deferred; typed-password entropy unverifiable |
| — | Secret-leakage audit | — | 2 | `38bef01` | `leak.test.mjs` (fetch spy) | **Not reproducible / clean — proven** | — |
| — | Backup re-audit (v1/v2 metadata unauthenticated) | LOW | 2 | `38bef01` | `backup.test.mjs` (18 tamper) + real v3 fixture | **Remediated** | legacy v1/v2 metadata treated as untrusted |
| — | BIP-39 passphrase confirmation | MED | 2 | `38bef01` | `passphrase.test.mjs` | **Remediated** | — |
| P6 | testnet emitted `xpub` not `tpub`; no descriptors | MED | 3 | `5be8611` | `descriptor.test.mjs` + Core `getdescriptorinfo`/`deriveaddresses` | **Remediated** | descriptor export is BIP-84 |
| P5 | Single-address; change reused; no discovery | MED | 3 | `adeb88c` | `recovery_live.mjs` (testnet4) + Core | **Remediated** | gap-limit scan window (below) |
| P12 | Wrong-network rejected only cryptically | MED | 3 | `adeb88c` | `wrong_network.test.mjs` (4 formats × 2) | **Remediated** | — |
| P7 | Hand-rolled P2PK needs much stronger testing | MED/HIGH | 4 | `76137d6`, `329e801` | `p2pk_vectors.test.mjs` (40) + Core + independent sighash + live t4/signet | **Verified correct — no defect** | educational museum feature |
| P8 | CSP/clickjacking not at HTTP-header level | LOW/MED | 5 | `e77322c` | `verify-headers.mjs` (external) + Chromium CSP | **Remediated** | `style-src 'unsafe-inline'`; Turnstile host (justified) |
| P9 | Online/offline threat-model wording | LOW | 5 | `e77322c` | `docs/THREAT_MODEL.md` | **Remediated** | — |
| P11 | Reproducible-build hardening | LOW/MED | 5 | `e77322c` | deterministic hashes + hash chain | **Remediated** | HSTS `preload` not yet submitted |
| — | Dependency / supply-chain audit | — | 5 | `e77322c` | `npm audit` = 0; esbuild demoted to devDep | **Remediated** | no independent audit |
| P10 | Rewrite SECURITY.md | LOW | 6 | *this pass* | `SECURITY.md` | **Remediated** | — |

Phase reports with full detail: `docs/PHASE1_REMEDIATION.md` … `PHASE5_REMEDIATION.md`.

## Evidence taxonomy — how strong is each claim

The order rightly asks to distinguish proofs from assumptions.

**A. Proven against Bitcoin Core (independent implementation)**
- Transaction serialisation & txid (every script type decodes identically; `scripttypes`, `freeze`, `p2pk_vectors`).
- Output descriptors: our checksum == `getdescriptorinfo`; `deriveaddresses` == Olesia for both chains, indexes 0–25.
- P2PK structure: fund output decodes as `pubkey`, spend as legacy scriptSig + nulldata.

**B. Verified against live deployments / live networks**
- Deterministic recovery + change-chain rotation (testnet4, `recovery_live`).
- P2PK real-network acceptance (testnet4 **and** signet mint+spend, `p2pk_live`).
- Full script-type E2E broadcasts (testnet3 + testnet4).
- Security headers present in the live HTTP response (`verify-headers` on preview).
- Source→build→deployment hash chain: built == served == pinned (wallet + cold gen).

**C. Browser / security tested**
- CSP enforced by real headless Chromium: wallet and cold generator run with **zero
  violations**; the app generated a 24-word seed under the strict hash-CSP.
- Offline cold generation from `file://` (meta-CSP path) — zero violations.
- `ui.test.mjs`: real-DOM regression incl. the freeze invariant and the OP_RETURN fee-wiring bug.
- Independent sighash: P2PK signatures verified against a **separately-coded** BIP-143 and
  legacy sighash (not the production preimage).

**D. Design assumptions — NOT proofs**
- The user's device, OS, and browser are trusted; a compromised client defeats any web wallet.
- Browser memory cannot be guaranteed zeroised; no secure-wipe is claimed.
- Gap-limit discovery has a finite scan window (funds isolated >20 past the last used address
  need a manual larger-gap rescan).
- **No independent third-party audit has been performed.** Cross-checks against Bitcoin Core
  and live networks are strong evidence but are not an external code audit.

## Test inventory

Offline suite (`cd packages/bitcoin && npm test`) — **16 groups**: tx, psbt, scripttypes,
p2pk, p2pk_vectors, vault, wif, descriptor, fee, freeze, psbt_verify, leak, backup,
passphrase, wrong_network, ui. Live (network + faucet, not in the default run):
`e2e_live.mjs`, `p2pk_live.mjs`, `recovery_live.mjs`. Cold generator has its own suite
(`npm test` at repo root).

---

## Production release checklist (follow verbatim)

Run before promoting. This makes the promotion itself auditable rather than a manual leap.
`REV` = the reviewed commit.

```sh
# 1. Clean checkout at the reviewed commit
git clone https://github.com/testnetbtc/BTC_Wallet && cd BTC_Wallet && git checkout $REV

# 2. Dependency install from lockfile (fails on drift)
npm ci
(cd packages/bitcoin && npm ci)

# 3. Test suites
(cd packages/bitcoin && npm test)      # expect: 16 groups PASS
npm test                               # cold-generator suite: expect PASS

# 4. Clean, deterministic builds
npm run build                          # cold generator -> public/index.html + public/_headers
(cd packages/bitcoin && node web/build.mjs)   # wallet -> web/index.html + web/_headers

# 5. Artifact hashes
sha256sum public/index.html            # must equal the hash pinned in VERIFY.md
sha256sum packages/bitcoin/web/index.html
#   (optional) build a second time and confirm both hashes are byte-identical

# 6. External header verification (PREVIEW)
node tools/verify-headers.mjs preview  # expect: HEADER VERIFY PASS on all 5 endpoints

# 7. Chromium CSP test (headless) — wallet + cold generator load with ZERO violations
#    (see tools/ smoke scripts; app must init window.OW and generate a 24-word seed)

# 8. Offline cold-generator test — open public/index.html via file://, confirm it runs
#    and shows zero CSP violations

# 9. Preview hash comparison — served == built
curl -s https://preview.alea-wallet.pages.dev/  | sha256sum   # == public/index.html
curl -s https://preview.olesia-wallet.pages.dev/ | sha256sum   # == packages/bitcoin/web/index.html

# 10. PRODUCTION deployment (all three, together, same reviewed commit)
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
npx wrangler@3.114.0 pages deploy public  --project-name=alea-wallet    --branch=main
npx wrangler@3.114.0 pages deploy landing --project-name=olesia-landing --branch=main
#   wallet: stage web/index.html + web/_headers (+ icons/manifest/assetlinks), then:
npx wrangler@3.114.0 pages deploy <stage> --project-name=olesia-wallet  --branch=main

# 11. PRODUCTION re-verification
node tools/verify-headers.mjs production        # expect: HEADER VERIFY PASS
curl -s https://offline.olesia.io/ | sha256sum  # == pinned cold-gen hash
curl -s https://app.olesia.io/     | sha256sum  # == built wallet hash
```

**Abort criteria:** any test failure, any non-deterministic hash, any header-verify failure,
any served≠built mismatch, or any CSP violation in the browser test.

## Conclusion

The findings identified in the internal review have been remediated and tested to the scope
documented above. Correctness of transaction construction, signing, derivation, descriptors,
and P2PK is cross-checked against Bitcoin Core and, where applicable, live networks; the
deployment boundary is verified in live responses and a real CSP-enforcing browser. Remaining
limitations — most importantly the absence of an independent third-party audit — are recorded
here and in `SECURITY.md`. Olesia should be treated as an educational, testnet-first wallet,
with only small amounts on mainnet until an independent audit is completed.
