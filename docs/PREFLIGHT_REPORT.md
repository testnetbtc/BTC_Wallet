# Chainwatch / Alea VPS — Preflight Report

**Date:** 2026-08-05 21:10 UTC · **Host:** `vmi2936609` · **User:** `faucet` (uid 1000, in `sudo`,`users`)
**OS:** Ubuntu 24.04.3 LTS (noble), kernel 6.8.0-136 · **Status:** inspection only — no changes made.

## Executive summary
A prior agent already completed "Phase 1": Bitcoin Core **v31.1.0** is installed and
**actively performing IBD** as a dedicated `bitcoin` user, pruned, with the **basic
block-filter index built from genesis and in lockstep with the chain**. This is the
single most important thing to get right, and it is correct — there is **no
prune-before-filter hazard**. Tor and PostgreSQL are **not yet installed**. The
Alea repo exists on the box but at `/home/faucet/BTC_Wallet`, not yet under
`bitcoinnode/`. **One hard blocker:** general `sudo` requires a password
(non-interactive root is unavailable to this agent), so every root step must be run
by the operator via reviewed scripts.

## Bitcoin Core — the node
| Item | Value |
|---|---|
| Version | **v31.1.0** (`/usr/local/bin/bitcoind`) — matches brief requirement |
| Managed by | systemd `bitcoind.service` — **active + enabled** |
| Running as | user `bitcoin`, `-datadir=/var/lib/bitcoind -conf=/var/lib/bitcoind/bitcoin.conf` |
| Actual datadir | **`/var/lib/bitcoind`** (NOT under `bitcoinnode/`; on `/` filesystem) |
| Chain | main |
| Block height | **451,178** |
| Header height | **961,204** |
| Verification progress | **13.86%** |
| Initial block download | **true** (in progress) |
| Pruning | **pruned=true**, automatic, target **146.8 GB** (`prune=140000`); `pruneheight=0` (not yet trimming — under target) |
| Size on disk | **115.7 GB** |
| `blockfilterindex=basic` | **YES** — `getindexinfo`: `synced:true`, `best_block_height:451178` (== block height) |
| txindex | disabled (not set; `disablewallet=1`) |
| Wallet keys in Core | **none** — `disablewallet=1` |
| RPC binding | **127.0.0.1:8332 only** (verified via `ss`) |
| RPC auth | `rpcuser=chainwatch` + `rpcpassword=<openssl rand -hex 32>` in `bitcoin.conf` (chmod 600, localhost-only) |
| ZMQ | **127.0.0.1** only: `pubrawtx@28332`, `pubhashblock@28333` |
| Tor | **NOT configured** — `proxy:""`, onion `reachable:false`; clearnet only |
| P2P | `8333` listening on `0.0.0.0` + `[::]` (clearnet inbound open); 10 peers (9 out / 1 in via v2) |

## Tor
**Not installed** (`command -v tor` → nothing; no `tor.service`). Ports 9050/9051 not listening.

## PostgreSQL
**Not installed** (`command -v psql`/`pg_ctl` → nothing; no `postgresql.service`). 5432 not listening.

## Firewall
`ufw` is **active** (single firewall; nftables/firewalld inactive). Ruleset not yet
readable — needs root (`sudo ufw status verbose`).

## Repository (Alea)
- Present at **`/home/faucet/BTC_Wallet`** only (not yet at `bitcoinnode/BTC_Wallet`).
- Branch `main`, remote `git@github.com:testnetbtc/BTC_Wallet.git`, latest `bc51a87`
  (pushed). Working tree clean **except** one untracked stray `check_bridge.mjs`
  (unrelated bridge-audit file; should be removed/ignored, not committed).
- Node v22.22.3, npm 10.9.8. Build/test integrity to be re-verified as first impl step.

## Discrepancies vs the new brief (to reconcile in later, reversible stages)
1. **ZMQ topics:** brief wants `pubrawblock@28333` + `pubsequence@28334`; node currently
   publishes `pubhashblock@28333` and no sequence. The worker design needs raw blocks +
   sequence → a `bitcoin.conf` ZMQ change + controlled restart (not IBD-affecting).
2. **Tor:** brief wants Bitcoin Core outbound via `proxy=127.0.0.1:9050` + `listenonion`.
   Requires installing Tor, then a config change + restart.
3. **RPC auth:** localhost `rpcuser/rpcpassword` works; brief prefers cookie/`rpcauth`.
   Low priority (already localhost-only, 600 perms).
4. **Repo location:** milestone wants repo at `bitcoinnode/BTC_Wallet`; it's at `~/BTC_Wallet`.
5. **prune target:** brief suggested `143360`; installed `140000` (146.8 GB). Fine.

## Observations / notes (not touched)
- `/home/faucet/faucet_wallet_backup.dat` (a `wallet.dat`, mode 600) and
  `/home/faucet/.bitcoin/` with a `testnet4/` subdir exist — **pre-existing operator
  files unrelated to Chainwatch** (the Chainwatch node is the mainnet one at
  `/var/lib/bitcoind`). Left untouched. Only **one** `bitcoind` process is running.
- `~/.bitcoin/testnet4` had a recent mtime; no second `bitcoind` process was observed.
  Flagging for the operator's awareness; not investigated further (out of scope).

## Disk safety
`/` = 338 GB, **137 GB free (60% used)**. Bitcoin data ~115.7 GB will grow to the
146.8 GB prune ceiling (+~31 GB), then hold near target as chainstate (~10 GB at tip)
and the filter index (~10 GB at tip) fill in. Rough steady-state Bitcoin footprint
≈ 170–185 GB. PostgreSQL + backups + logs are additive but initially small. **Adequate,
but disk is the primary thing to monitor** — I'll wire the 70/80/90% alerts early.

## Stop-condition check (brief §24) — all CLEAR
- Filter index built before pruning: **YES (clear)** · Re-download risk: **none seen**
- Disk unsafe: **no** · Core older than v31.1: **no** · >1 Core instance: **no (one)**
- RPC public: **no (localhost)** · Uncommitted wallet work at risk: **no** · Tor blocking
  reconnect: n/a (not yet enabled) · Mnemonic/privkey found in Chainwatch scope: **no**

## The one blocker
`sudo -n true` → **password required**. The only passwordless privilege is
`faucet ALL=(bitcoin) NOPASSWD: /usr/local/bin/bitcoin-cli` (how I queried the node).
Therefore **all root-requiring steps** (apt install tor/postgresql, edit
`/var/lib/bitcoind/bitcoin.conf`, restart bitcoind, ufw, `/etc/systemd/system`) must be
executed by the operator — I will deliver reviewed, reversible, idempotent scripts +
rollback for each, mirroring the existing `setup-phase1.sh` model.

## What I can do now WITHOUT root (proposed next stages)
Repo & app scaffolding (services/, packages/, migrations/, infra/ definitions, docs/,
tests/), the Bitcoin RPC client + ZMQ subscriber + decoders, DB schema/migrations,
alert-rule engine, status API (localhost), `.env.example`, secret-input rejection,
hardened systemd unit files + install scripts (staged, not installed), Tor/Postgres
config files + install scripts (staged), backup/monitoring scripts, and re-verifying
`npm ci && npm run build && npm test` — all without touching the running node.
