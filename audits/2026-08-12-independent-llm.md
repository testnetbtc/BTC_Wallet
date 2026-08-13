# Olesia audit — 2026-08-12 — independent LLM review

- Commit: `5d98a10` ("docs: release note for the Home per-type-balance production promotion")
- Cold-generator `index.html` SHA-256 reviewed: `34625d6d4b3b79000170615305eefbfc2e100f2afe37f5181757ec3d324d8a51` (matched a clean rebuild)
- Scope: entire public repository — cold generator, hot wallet (`packages/bitcoin`), broadcast service, landing, infra, tests, CI, docs
- Method: full source review of crypto/tx/signing/encryption paths, CSP/headers, static analysis for injection/XSS/secrets/eval, test execution, reproducible-build verification, dependency inspection, cross-check vs `AUDIT.md` / `THREAT_MODEL.md` and prior public audits
- Verdict: **No Critical/High/Medium in the cryptographic core, key generation, derivation, signing, encryption, or transaction construction.** Two Low findings (packaging + defence-in-depth), both since fixed.

## Findings (most severe first)

### L-1 (Low) — `@noble/ciphers` not declared in the bitcoin package
- Where: `packages/bitcoin/package.json`
- Reachability: `src/vault.js` and `src/coldbackup.js` import `@noble/ciphers`, but it was declared only in the **root** `package.json`. It resolved via the root `node_modules`, so a clean `npm ci` inside `packages/bitcoin` alone failed — breaking reproducibility for anyone building the package in isolation.
- Fix: **Fixed** in `275daf2`. Declared `@noble/ciphers ^0.5.3` (the already-resolved version) and synced the package lockfile. Verified the only resulting bundle delta is an esbuild path comment (`../../node_modules/@noble/ciphers` → `node_modules/@noble/ciphers`); the library code is byte-identical. The hot-wallet build is now reproducible from a clean per-package `npm ci`.

### L-2 (Low) — explorer-supplied `txid` interpolated into `innerHTML`
- Where: `packages/bitcoin/web/ui.js` (Home activity renderer)
- Reachability: a hostile or compromised block explorer could return a `txid` field containing markup; it was placed into a template literal assigned to `innerHTML`. Practical risk is low (txids are normally 64-hex and the CSP blocks external/inline script via hashes), but it violated least-privilege.
- Fix: **Fixed** in `275daf2`. The row is now built with `createElement`/`textContent`, so the txid can never be interpreted as markup; the explorer URL was hardened with `encodeURIComponent`; the WIF-inspect address was escaped; an `esc()` helper was added. A regression test proves a markup-bearing txid creates no `<img>` node and never fires `onerror`. `psShowStrength` was reviewed and left unchanged — it interpolates only numbers, never the user's passphrase.

## Informational (auditor observations, no change required)
- `p2pk_vectors.test.mjs` Core cross-checks fall back to a soft skip when `bitcoin-cli` is absent (expected in a clean env; the hand-rolled P2PK path is still exercised by independent sighash vectors).
- Hot-wallet mainnet mode is explicit opt-in with warnings and a stronger vault bar; browser JS cannot securely zero memory (documented; the cold-generator + air-gap PSBT flow is the intended path for real value).
- The Home per-type-balance change in this commit is UI only — it does not touch signing, derivation, vault, CSP, or the cold generator.

## Remediation summary
Both Low findings fixed in commit `275daf2` (on top of `5d98a10`). Offline suite 16/16 green
(real-DOM UI suite extended to 25 checks, incl. the new XSS regression). Production hot wallet
redeployed and verified reproducible: `app.olesia.io` served bytes == deployment == clean build
`69ef63e7…`. Cold-generator artifact and its pinned hash `34625d6d…` were not touched.
