# Implementation Status

Branch: `feature/chainwatch-infrastructure` · Repo: `/home/faucet/BTC_Wallet`
(kept here per operator decision; `bitcoinnode/` is the data/infra/staging home).
Updated: 2026-08-06.

## Milestone 1 checklist (brief §25)
| # | Item | State |
|---|---|---|
| 1 | VPS inventory documented | ✅ `docs/PREFLIGHT_REPORT.md` |
| 2 | Active Bitcoin data dir known | ✅ `/var/lib/bitcoind` |
| 3 | Core version documented | ✅ v31.1.0 |
| 4 | IBD continues normally | ✅ 13.9% and climbing |
| 5 | `blockfilterindex=basic` confirmed | ✅ synced to tip |
| 6 | Prune state confirmed | ✅ prune target 146.8 GB |
| 7 | Tor installed | ⛔ blocked on root |
| 8 | Core verified via Tor proxy | ⛔ blocked on root |
| 9 | Node onion service verified | ⛔ blocked on root |
| 10 | RPC + ZMQ localhost-only | ✅ verified via `ss` |
| 11 | PostgreSQL installed, localhost-only | ⛔ blocked on root |
| 12 | Repo present | ✅ `~/BTC_Wallet` (operator chose to keep path) |
| 13 | Wallet passes `npm ci && build && test` | ✅ 8/8 green (`f41c774`) |
| 14 | Live site unchanged | ✅ https://alea-wallet.pages.dev (hash `96ad5024`) |
| 15 | Backend dirs + migrations exist | 🔶 dirs done; migrations pending |
| 16 | Systemd units prepared | 🔶 pending (drafts, not installed) |
| 17 | Internal node-status API works | 🔶 pending |
| 18 | No private wallet secrets on VPS | ✅ Core `disablewallet=1`; none placed |
| 19 | All changes have rollback | ✅ `docs/CHANGELOG-INFRASTRUCTURE.md` |
| 20 | Status report exists | ✅ this file |

Legend: ✅ done · 🔶 in progress · ⛔ blocked.

## Completed
- Preflight report; all §24 stop-conditions clear.
- Alea baseline preserved; test regression fixed; full suite green.
- Feature branch + repo scaffold (`services/`, `packages/`, `migrations/`,
  `infra/`, `docs/`, `tests/`); `.gitignore` secret hygiene; `.env.example`.
- Living docs: `WEBSITE_INTEGRATION.md`, `CHANGELOG-INFRASTRUCTURE.md`, this file.

## In progress / next (no root needed)
- `packages/bitcoin`: RPC client (cookie auth) + ZMQ subscriber + tx/block decoders.
- `packages/database` + `migrations/`: schema for the 15 tables (brief §10), with
  xpub/descriptor columns encrypted at rest.
- `packages/rules`: alert-rule engine (candidate-labelled heuristics, brief §18).
- `packages/shared`: secret-input rejection (reject seeds/xprv/WIF before log/db).
- `services/api`: `GET /v1/status` + watch-target CRUD skeleton, bound to 127.0.0.1.
- Hardened systemd unit **drafts** under `infra/systemd/` (installed later).
- Tor + PostgreSQL config + install **scripts** under `infra/` (run later as root).

## Blocked on root (operator granting passwordless sudo)
Tor install/verify, `bitcoin.conf` changes + controlled restart, PostgreSQL install,
`ufw` rules, systemd unit installation. Scripts will be staged and reviewable first.

## Guardrails held
Offline Alea untouched and standalone · node never restarted · no secrets in git ·
RPC/ZMQ localhost-only · public site and project name unchanged.
