# Olesia — Production Release Record (2026-08-12)

Release of the Phases 1–6 security remediation to production, executed under a
controlled release gate. Production was verified byte-for-byte against the audited
commit; no pins were altered to match production.

## Deployed release

- **SHA:** `f9ec79eb0c7474e9aa49e25a445bd180119bc10b`
- **Branch:** `release/audited-plus-gatefix`
- **Basis:** the operator-reviewed commit `3282021b62eca4cc34f1e33644290337dadb15b3`
  **plus only** the two corrections the release gate surfaced. **No Telegram/notify
  work included.** No source changes were made during the release.

### Release delta — `git diff --stat 3282021..f9ec79eb`

```
 AUDIT.md                           |   2 +-
 README.md                          |   4 +-
 VERIFY.md                          |   2 +-
 docs/PHASE5_REMEDIATION.md         |   4 +-
 index.html                         |   2 +-   ← cold-gen artifact: adds frame-src 'none' CSP line
 landing/index.html                 |   2 +-
 packages/bitcoin/package-lock.json | 542 +++++...   ← jsdom devDependency lockfile sync
 7 files changed, 549 insertions(+), 9 deletions(-)
```

Contamination check: **zero** notify/telegram files.

### What the two gate corrections were

1. **Lockfile sync** — `packages/bitcoin/package-lock.json` was missing `jsdom` (a
   `ui.test` devDependency), so `npm ci` failed. Synced. Proven artifact-neutral: the
   wallet build hash is byte-identical (`b16f8f66…`) since jsdom is test-only, never
   bundled.
2. **Cold-generator reproducible-hash correction** — the pinned `77a2752609…` predated
   the `frame-src 'none'` already present in `tools/csp.mjs` at `3282021`, so the
   committed artifact did not match a clean build. Rebuilt `index.html` deterministically
   to `34625d6d…` (strictly more locked-down) and re-pinned `77a2752609… → 34625d6d…` in
   README/VERIFY/AUDIT/landing + the Phase 5 report.

## Step 10 — Production promotion (all three together, from `f9ec79eb`)

| Component | Domain | Production deployment id |
|---|---|---|
| Hot wallet | app.olesia.io | `d6be9636` |
| Cold generator | offline.olesia.io | `bc8c747d` |
| Landing | olesia.io | `31ff68e6` |

## Step 11 — Immediate production verification (all green)

### ① External security headers — live domains

```
✓ wallet   https://app.olesia.io/
✓ coldgen  https://offline.olesia.io/
✓ landing  https://olesia.io/
✓ faucet   https://olesia.io/faucet/
✓ p2pk     https://olesia.io/p2pk/
HEADER VERIFY PASS (production) — CSP present, script hatches absent, framing blocked
```

Verifier: `node tools/verify-headers.mjs production`. Each endpoint asserts CSP present,
no `script-src 'unsafe-inline'`/`'unsafe-eval'`, and framing blocked
(`X-Frame-Options: DENY` + `frame-ancestors 'none'`).

### ② Served production bytes == pinned/reviewed hashes (tied to `f9ec79eb`)

```
app.olesia.io      served = b16f8f669031361c425becbafd88f51455e35ac041b8389dc66dbe57403de3d6
                   == f9ec79eb wallet build                                      ✓ TIED TO f9ec79eb
offline.olesia.io  served = 34625d6d4b3b79000170615305eefbfc2e100f2afe37f5181757ec3d324d8a51
                   == pinned VERIFY.md                                           ✓ TIED TO f9ec79eb + pinned
```

### ③ Real Chromium CSP — live domains (headless, CSP enforced)

```
app.olesia.io      window.OW functional · generated a 24-word seed under the hash-CSP · CSP violations: NONE ✓
offline.olesia.io  window.Olesia functional · CSP violations: NONE ✓
```

## Confirmation

- **All three production components were promoted together** from the exact release commit
  `f9ec79eb`.
- **Chain of custody intact:** audited `3282021` → clean `f9ec79eb` (verified diff, no
  contamination) → preview gate (green) → production (served bytes hash-match `f9ec79eb`
  on both hash-pinned artifacts).
- **No pins were altered to match production** — the served bytes matched the pre-existing
  pinned/reviewed hashes.
- **No abort condition triggered** at any step (no hash mismatch, no missing header, no CSP
  violation, and the deployed content ties back to `f9ec79eb`).

## Housekeeping (not release blockers)

1. **Repo state:** production is `f9ec79eb` (the clean release branch). `main` is at
   `e495c1c`, which still contains an earlier contaminated commit (the two fixes bundled
   with another agent's notify backend + the Telegram scaffold). Recommended follow-up:
   cherry-pick the two clean fixes onto `main` and move the notify work to its own feature
   branch, so `main` and production reconcile cleanly. `main` was not touched during the
   release.
2. **Telegram page is intentionally not in production** (it post-dated the reviewed commit).
   It remains available for the notify agent to build against and can be promoted separately
   after review.

## Pre-production gate (for reference)

Run from a fresh clone of `f9ec79eb` before promotion — all green:

- Clean checkout based directly on `3282021`; clean tree.
- `npm ci` (root + bitcoin); `npm audit` = 0 both.
- Test suites: wallet 16/16 (incl. UI); cold-generator suite pass.
- Deterministic builds (byte-identical across rebuilds).
- Artifact hashes: cold-gen `34625d6d…` == pinned; wallet `b16f8f66…` == reviewed.
- Preview: external headers PASS (5 endpoints); Chromium CSP zero violations
  (wallet/cold-gen/faucet/p2pk); offline `file://` cold generator zero violations;
  served == built == pinned.
