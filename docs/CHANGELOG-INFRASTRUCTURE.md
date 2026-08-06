# Infrastructure Change Log

Every VPS/infra change is recorded here: date/time, what changed, backup path,
command, reason, validation, rollback. No undocumented production changes.

Times are UTC. Host `vmi2936609`, user `faucet`.

---

## 2026-08-05 — Preflight inspection (read-only)
- **Change:** none (inspection only).
- **Reason:** mandatory preflight before any change (brief §2).
- **Commands:** `whoami/id/df/free/lsblk/timedatectl`, `ps aux`, `ss -lntu`,
  `systemctl`, and `sudo -u bitcoin bitcoin-cli {getblockchaininfo,getindexinfo,
  getzmqnotifications,getmempoolinfo,getnetworkinfo,-netinfo}`.
- **Findings:** Bitcoin Core v31.1.0 mid-IBD (block 451,178/961,204), pruned
  (target 146.8 GB), `blockfilterindex=basic` synced to tip, RPC+ZMQ localhost-only,
  no Tor, no PostgreSQL. Full report in `docs/PREFLIGHT_REPORT.md`.
- **Validation:** n/a. **Rollback:** n/a.

## 2026-08-05 — Alea repo: baseline verify + test regression fix (branch `main`)
- **Change:** fixed `src/nettest.mjs` and `src/latchtest.mjs`; moved stray
  `check_bridge.mjs` out of the repo; hardened `.gitignore`.
- **Backup:** git history (commit `bc51a87` is the prior state; fix is `f41c774`).
- **Reason:** `npm test` was red — the earlier testnet3/4 rename moved a result key
  (`out.testnet`→`out.testnet3`) and added DOM elements the latchtest shim lacked.
  Caught because this milestone requires the full suite green (brief §25.13).
- **Commands:** `npm ci && npm run build && npm test`.
- **Validation:** full suite 8/8 green; `index.html` byte-identical (build still
  reproduces the published hash `96ad5024…37a28f`), so **no redeploy** needed.
- **Rollback:** `git revert f41c774`.

## 2026-08-06 — Repo scaffold for Chainwatch (branch `feature/chainwatch-infrastructure`)
- **Change:** created `services/{api,worker,telegram}`, `packages/{bitcoin,database,
  rules,shared}`, `migrations/`, `infra/{bitcoin,tor,postgres,systemd,firewall,scripts}`,
  `docs/`, `tests/{integration,regtest}`; added `.env.example`, `.gitignore` secret
  rules, and living docs (this file, `WEBSITE_INTEGRATION.md`, `IMPLEMENTATION_STATUS.md`).
- **Reason:** brief §12/§19 repository workstream; no node impact.
- **Validation:** `npm test` still green; nothing touches `/var/lib/bitcoind`.
- **Rollback:** delete the branch (nothing merged to `main`).

---

## Pending (require root — run after passwordless sudo is granted)
Each will get its own dated entry with backup + rollback when executed:
1. Install Tor (`apt install tor`), configure SOCKS/control on localhost, verify.
2. `bitcoin.conf`: add Tor proxy/listenonion/torcontrol; switch ZMQ to
   `pubrawblock@28333` + add `pubsequence@28334`; **back up conf first**, validate
   with `bitcoind -conf=… -testconfig` equivalent, then `systemctl restart bitcoind`
   and confirm IBD resumes + filter index continues.
3. Install PostgreSQL, create `chainwatch` db + `chainwatch_app` role, localhost-only.
4. `ufw` review + rules (keep RPC/ZMQ/PG/Tor closed).
5. Install hardened systemd units for the three backend services.
