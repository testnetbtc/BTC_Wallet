# Olesia Wallet ↔ Atomic-Swap Connect — setup

Implements the injected provider from `/home/faucet/olesia-atomic/docs/OLESIA_WALLET_HANDOFF_CONTRACT.md`
so a user can sign the Bitcoin side of a swap in their **own** Olesia wallet, non-custodially.
The swap engine tree is **never modified** — this is the whole website side.

## What runs where

| Piece | Origin | File(s) | Role |
|---|---|---|---|
| **Provider** `window.olesia` | swap page | `connect/olesia-provider.js` | injected on the swap origin; holds NO keys; relays `olesia_getAccount` / `olesia_signPsbt` to the wallet via a popup + postMessage |
| **Connect bridge** | `app.olesia.io/connect` | `connect/{core,entry}.mjs`, `connect/index.html` → `connect/dist/` | where the seed lives; unlocks the same-origin vault, shows a WYSIWYS review, signs the HTLC, posts the signed tx back |
| **HTLC signer** | engine | `src/htlc_sign.js` | P2WSH SHA256+CLTV redeem/refund, SIGHASH_ALL; reuses the PSBT's unsigned-tx bytes so the segwit **txid equals the engine intent** (verified against the engine's own `verifySignedAgainstIntent`) |

Non-custody: the wallet only ever returns a **signed transaction**; the swap engine verifies those
bytes semantically against an immutable intent and broadcasts the exact verified bytes, or fails
closed. Testnet only (`testnet4` / `signet`); mainnet is refused on both sides.

## Deploy (operator)

**1 — Ship the provider + connect page on `app.olesia.io`** (the wallet Pages project). Build and
stage them into the wallet publish dir, then deploy as usual:
```
cd packages/bitcoin
node web/build.mjs && node connect/build.mjs
# stage into the wallet deploy folder:
cp connect/olesia-provider.js web/publish/olesia-provider.js
mkdir -p web/publish/connect && cp connect/dist/index.html connect/dist/_headers web/publish/connect/
# deploy (same flow as the wallet):
set -a; . .secrets/cloudflare.env; set +a
npx wrangler pages deploy web/publish --project-name=olesia-wallet --branch=main
```
Now `https://app.olesia.io/olesia-provider.js` and `https://app.olesia.io/connect/` are live.

**2 — Put the swap UI on a same-site origin (`swap.olesia.io`).** The swap server serves the page
at `/swap` and its API at `/api/swap/v1`, and the page imports root-relative assets (`./eth-wallet.js`),
so a **subdomain** (not a path) is the clean routing:
- `cloudflared` ingress: `swap-origin.olesia.io` → `http://127.0.0.1:8975` (keep this hostname off the Worker route).
- Deploy the injector Worker (`infra/cloudflare/olesia-swap-worker.js`) on route `swap.olesia.io/*`
  with `SWAP_ORIGIN=https://swap-origin.olesia.io`. It proxies every path to the swap server and
  appends one `<script src=".../olesia-provider.js">` to the page — nothing else changes.

Result: the swap page at `https://swap.olesia.io` detects `window.olesia` and drives signing. Until
step 2 is done, the swap page's **manual fallback** (export PSBT → sign in `offline.olesia.io` → paste
back) already works with zero infra.

## Security model
- **Origin pinning both ways.** The provider only trusts messages from `https://app.olesia.io`; the
  connect page only accepts requests from `https://swap.olesia.io` / `https://olesia.io` (allow-list
  in `connect/index.html`). postMessage always uses an explicit `targetOrigin`, never `*` for data.
- **Keys never leave `app.olesia.io`.** The provider and swap page never see seed or key material —
  only a finished signed transaction.
- **The signer is fail-closed:** refuses if the branch key isn't in this wallet, if SIGHASH ≠ ALL,
  if the P2WSH doesn't match the witnessScript, or (redeem) if the secret doesn't hash to the HTLC's H.
- **The connect page is network-less** (CSP `connect-src 'none'`, hash-pinned scripts, not framable)
  and the wallet-signed bytes are re-verified by the engine before any broadcast.

## Tests
`test/htlc_sign.test.mjs` (engine-accepted redeem/refund, txid-preserving, fail-closed) and
`test/connect.test.mjs` (hardened bridge, engine-backed `getAccount`/`sign`, origin-pinned provider).
