# Mothball record — 2026-10-01

The operator re-scoped Olesia to **one thing: the mainnet wallet at olesia.io**. Everything else
is mothballed — switched off but kept intact, so any piece can be brought back. Nothing was
deleted: no code, no keys, no data, no Cloudflare project.

## What is LIVE now

| Piece | Where | Notes |
|---|---|---|
| Mainnet wallet (the opening page) | `olesia.io` → Pages project `olesia-landing` | source `packages/bitcoin/mainnet/`, build `node mainnet/build.mjs` |
| Node API | `api.olesia.io` → tunnel → `127.0.0.1:8787` | `olesia-nodeapi.service`, source `infra/nodeapi/` |
| Bitcoin node | `bitcoind -datadir=/home/faucet/gsmg-frontier/btc_mainnet_node` | started by hand; not a systemd unit |

## What was switched off, and how to switch it back on

| Piece | What was done | To restore |
|---|---|---|
| Faucet API (`faucet.olesia.io`, :8790) | **Back in service since 2026-10-02 (late)** in no-own-node mode: `.secrets/own-nodes.json` = `{}`, so every network uses public data. | To stop again: `sudo systemctl disable --now olesia-faucet`. To return to own-node mode: re-sync the test nodes and remove `own-nodes.json`. |
| Faucet dashboard (:8793) | `sudo systemctl disable --now olesia-faucet-dashboard` | `sudo systemctl enable --now olesia-faucet-dashboard` |
| Nostr faucet bot | `sudo systemctl disable --now olesia-nostr-bot` | `sudo systemctl enable --now olesia-nostr-bot` |
| Telegram notifier | `sudo systemctl disable olesia-notify` (was already stopped) | `sudo systemctl enable --now olesia-notify` |
| Health monitor (restarted the faucet/bot every 5 min) | `sudo systemctl disable --now olesia-healthcheck.timer` | `sudo systemctl enable --now olesia-healthcheck.timer` |
| Old broadcast service | `sudo systemctl disable --now olesia-broadcast`; an orphan copy started by hand on Aug 27 (holding port 8787) was killed | superseded by `olesia-nodeapi` — do not restore both, they share port 8787 |
| Nightly P2PK-explorer rebuild + landing redeploy (03:30) | crontab line prefixed `#MOTHBALLED 2026-10-01` | remove the prefix (`crontab -e`). **Do not re-enable while the wallet is on olesia.io — this job deploys `landing/` over it.** |
| Old Python faucet daily reports (16:00, t3 + t4) | two crontab lines prefixed `#MOTHBALLED 2026-10-01` | remove the prefix |
| Landing site + sub-pages (`/p2pk`, `/faucet`, `/learn`, `/privacy`, `/telegram`) | no longer deployed; source untouched in `landing/` | `npx wrangler pages deploy landing --project-name=olesia-landing --branch=main` (this REPLACES the wallet on olesia.io) — or roll back to the previous deployment in the Cloudflare dashboard |

The original crontab is saved at `/home/faucet/olesiawallet/crontab.backup-2026-10-01.txt`.

## Kept on disk, untouched

- All source: `landing/`, `packages/bitcoin/web/` (multi-network hot wallet), `web/site/` (cold
  generator), `signer/`, `connect/`, `faucet/`, `nostr/`, `notify/`, `mobile/`, `p2pk-explorer/`,
  `infra/broadcast/`, root `src/` + `assemble.mjs` (the original generator).
- All secrets in `packages/bitcoin/.secrets/` — testnet faucet seeds, claim ledger, Nostr and
  Telegram credentials, Android signing key. Testnet coins are unaffected.
- `/home/faucet/olesia-atomic` + `/home/faucet/olesia-atomic-icebox` (atomic swaps, parked in August).
- `/home/faucet/olesia-twa` (Android build), `/home/faucet/faucet` (older Python faucet).
- The four old node datadirs `/var/lib/bitcoind*` (chain data was deleted on 2026-08-25 to free
  disk; see `/home/faucet/bitcoin-nodes-restore/RESTART_NODES.md`). The faucet and its
  reconciler need the testnet nodes re-synced before they can run again.

## Cloudflare Pages projects

Each old site now serves a small static notice (no scripts) pointing to olesia.io. The notice
pages live in `infra/mothball/{app,offline,signer}/`. The old sites' source is untouched.

| Project | Addresses | Now serves | To restore the old site |
|---|---|---|---|
| `olesia-landing` | `olesia.io`, `olesia-landing.pages.dev`, `mainnet-preview.olesia-landing.pages.dev` | the mainnet wallet | (old landing) `npx wrangler pages deploy landing --project-name=olesia-landing --branch=main` — replaces the wallet |
| `olesia-wallet` | `app.olesia.io`, `olesia-wallet.pages.dev`, `preview.olesia-wallet.pages.dev` | "this wallet has moved" notice at `/`; **the faucet claim page at `/faucet/`** (since 2026-10-02 late, source `infra/faucet-page/`) | build per `docs/AGENT_HANDOVER.md` §10, then `npx wrangler pages deploy web/publish --project-name=olesia-wallet --branch=main` |
| `alea-wallet` | `offline.olesia.io`, `alea-wallet.pages.dev`, `preview.alea-wallet.pages.dev` | "offline generator retired" notice | `npx wrangler pages deploy packages/bitcoin/web/site --project-name=alea-wallet --branch=main` |
| `olesia-signer` | `olesia-signer.pages.dev` | "offline signer retired" notice | `node signer/build.mjs` then `npx wrangler pages deploy signer/dist --project-name=olesia-signer --branch=main` |

Notes:
- **`app.olesia.io` kept visitors' encrypted wallets in that site's browser storage.** The notice
  page has no scripts and does not touch that storage, so restoring the old site (or rolling back
  in the Cloudflare dashboard) makes those saved wallets openable again. The notice tells
  visitors to import their recovery words at olesia.io and not to clear the site's data if they
  never wrote the words down.
- Every Pages deployment also has its own permanent address (`<hash>.<project>.pages.dev`). The
  old deployments still exist at those unlisted hash addresses and are what dashboard rollback
  uses. Deleting them would remove them for good; that was NOT done.
- `faucet.olesia.io` is still routed by the Cloudflare Tunnel to port 8790, where nothing listens
  (502). Removing the hostname is a Cloudflare dashboard change (the tunnel is token-managed).
- The node API no longer accepts browser requests from `app.olesia.io`.
- A leftover quick tunnel from the August swap work (`cloudflared tunnel --url
  http://127.0.0.1:8975`, a `trycloudflare.com` address) was still running with nothing behind
  it; it was stopped. The main tunnel (`cloudflared.service`) is untouched.

## Not part of Olesia — not touched

`chainwatch-*` services (a separate project; `chainwatch-sweep` has been crash-looping since the
old mainnet node was wiped), `/home/faucet/trading`, `/home/faucet/fabletrade`, `gsmg-*`, `MAPS`.
