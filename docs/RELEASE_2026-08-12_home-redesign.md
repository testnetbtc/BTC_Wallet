# Olesia hot wallet — feature release (2026-08-12): Home per-type balance

Follow-on release to the audited Phases 1–6 baseline (`f9ec79eb`). **Hot wallet only**
(`app.olesia.io`). No cold-generator, landing, or security-primitive changes; the
cold generator's pinned reproducible hash (`34625d6d…`) is untouched.

## What changed (source)

Commits on `main`, all pushed to `github.com/testnetbtc/BTC_Wallet`:

- `15b7f0a` — wallet: per-script-type Home balance + in-hero type selector + `‹ Home`
  back links on Accounts/Learn/Settings. The Home headline now shows the **selected**
  script type (was a single blended total that could hide, e.g., 1 tBTC on Legacy while
  viewing P2PK); each selector pill carries its own balance; a smaller "All accounts"
  combined total stays on show. UI DOM suite extended to 22 checks.
- `a5e00ab`, `c7c404e` — faucet backend coin-selection (confirmed-first, drip-sized
  bank). Server-side only; not part of the wallet bundle.

Only `web/ui.js`, `web/assemble.mjs`, and `test/ui.test.mjs` affect the wallet artifact.
No changes to signing, PSBT, vault/KDF, CSP builder, or address derivation.

## Release verification (controlled promotion)

- **Deterministic build:** `node web/build.mjs` twice → identical
  `index.html` sha256 `6c76c4e28d7efd7e20a039c5f5f41f95c7cf75adb1f625c57a2d25141208dc57`.
- **Offline suite:** 16/16 groups green (incl. the real-DOM UI test, now 22 checks).
- **Deploy:** Cloudflare Pages `olesia-wallet`, branch `main` (production),
  deployment `de897a4e`.
- **Production tie-back (raw, no shell newline artifact):**
  `app.olesia.io` served sha256 == `de897a4e` deployment == built `6c76c4e2…`.
- **Headers:** hash-based CSP (no `script-src 'unsafe-inline'`), `X-Frame-Options: DENY`
  + `frame-ancestors 'none'`, HSTS, `nosniff`, `no-referrer`. External verifier PASS.
- **No Cloudflare HTML transform:** custom-domain bytes are byte-identical to the
  `*.pages.dev` deployment (no Rocket Loader / Auto Minify / email-obfuscation injection).

## Note for an independent review

Production (`app.olesia.io`) now serves this build (source `c7c404e`), which is **ahead of**
the formally audited commit `f9ec79eb`. This is a UI/UX change on the same audited signing
core; the wallet is **not** described as "secure," "audited," or "formally verified."
