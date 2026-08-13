# RT-2 — Durable claim ledger & payout state machine (IMPLEMENTATION)

Makes faucet claims **durable, idempotent, crash-safe and exactly-once** at the
payment-intent level. Replaces the in-memory cooldown Maps with a SQLite ledger that is the
authority for "has this address claimed today" and "what exact transaction did we commit to".

**Mainnet payout execution is HARD-DISABLED** (`MAINNET_EXECUTION_ENABLED = false`,
`NETWORKS` excludes `mainnet`). The schema/state machine are network-generic and
mainnet-ready, but the faucet cannot spend mainnet funds without a separate deliberate change.

## Files
| File | Role |
|---|---|
| `faucet/ledger.mjs` | SQLite ledger: schema, migrations, health, transition matrix, durable reservations, idempotency keys |
| `faucet/claimflow.mjs` | `processClaim()` state machine + `reconcileState()` + live esplora/signer adapters |
| `faucet/recovery.mjs` | startup + periodic recovery worker |
| `faucet/server.mjs` | fail-closed startup, ledger-backed claim handler, API idempotency semantics |
| `faucet/telemetry.mjs` / `dashboard.mjs` | ledger health + claim-state counts; `DEGRADED` status |
| `test/ledger.test.mjs`, `test/rt2_crash.test.mjs`, `test/rt2_recovery.test.mjs`, `test/rt2_reservation.test.mjs` | in the CI suite |

## Storage
`node:sqlite` (**Node ≥ 22.5**, run with `--experimental-sqlite`; production runs Node
v22.22.3). If that API is unavailable the `import` throws at module load and the server refuses
to start — it **never** silently falls back to in-memory state (fail visible + fail closed).
Conservative pragmas: `journal_mode=WAL`,
`synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`. DB at
`.secrets/faucet-claims.db` (+ `-wal`/`-shm`). **Any** DB failure (open, migration, unexpected
schema version, integrity, write, commit) → the ledger is unhealthy → payouts stop (fail
closed); the dashboard shows `DEGRADED`, never healthy `RUNNING`.

## Schema (claims)
`claim_id` (PK, uuid) · `network` · `address` (display) · `canon` (output-script hex —
formatting-proof key) · `claim_day` (YYYY-MM-DD UTC) · `amount_sat` · `state` ·
`client_idempotency_key` · `request_fingerprint` · `reserved_outpoints` (JSON) · `raw_tx` ·
`local_txid` · `fee_sat` · timestamps (`created/updated/authorised/signed/first_broadcast/
last_broadcast/seen/confirmed_at`) · `broadcast_attempt_count` · `reconcile_attempts` ·
`confirmation_height/_block_hash` · `error_code/_detail_safe`.

Uniqueness: **`UNIQUE(network, canon, claim_day)`** — the authoritative payout entitlement —
and **`UNIQUE(network, client_idempotency_key)`** (RT-2B). The idempotency key is only a
**per-network retry handle**, never a global identity: two unrelated clients that both pick
`Idempotency-Key: claim-1` must not collide, and changing the key can never bypass the
entitlement rule. There is no reliable per-client identity in a public faucet, so network is the
strongest scope we can support honestly without inventing a fake identity (IP is deliberately
NOT used as a permanent identity). Separate `reservations(network, txid, vout PRIMARY KEY,
claim_id)` — a UTXO can be reserved by at most one claim, durably, committed **atomically** with
the claim.

## State machine
```
AUTHORISED → SIGNED → BROADCASTING → SEEN → CONFIRMED           (normal)
                          └→ UNCERTAIN ─(reconcile)→ SEEN/CONFIRMED/CONFLICTED
any → CONFLICTED (input spent by another tx)   any → FAILED_SAFE (safety failure)
```
| From | Allowed to |
|---|---|
| AUTHORISED | SIGNED, UNCERTAIN, CONFLICTED, FAILED_SAFE |
| SIGNED | BROADCASTING, UNCERTAIN, CONFLICTED, FAILED_SAFE |
| BROADCASTING | SEEN, CONFIRMED, UNCERTAIN, CONFLICTED, FAILED_SAFE |
| SEEN | CONFIRMED, UNCERTAIN, CONFLICTED |
| UNCERTAIN | SEEN, CONFIRMED, BROADCASTING, CONFLICTED, FAILED_SAFE |
| CONFIRMED / CONFLICTED / FAILED_SAFE | (terminal) |
Any move not in this table is rejected. `FAILED_SAFE` is reachable from anywhere (safety stop).
Terminals: `CONFIRMED` (success), `CONFLICTED`/`FAILED_SAFE` (manual review). `CONFLICTED`
**never** auto-builds a replacement transaction.

## Exact write/broadcast ordering (write-ahead)
1. validate + `mainnet` guard · 2. canonicalize address→`canon`, `claim_day`=UTC ·
3. `Idempotency-Key` replay/conflict check · 4. entitlement lookup (dup → return existing) ·
5. global daily cap · 6. **breaker.authorize** (new payout only) ·
7. **BEGIN → INSERT claim(AUTHORISED) + INSERT reservations → COMMIT** (durable, atomic) ·
8. build+sign the EXACT tx (`broadcast:false`) · 9. recompute txid==local_txid (I4) →
persist **SIGNED** (raw_tx, local_txid, fee, inputs) · 10. **reconcile-before-broadcast** ·
11. persist **BROADCASTING** → broadcast the EXACT raw_tx · 12. verify returned txid==local
(I5) → **SEEN** · 13. later reconciliation → **CONFIRMED**.

## UTXO reservation & retention (RT-2C)
`pickFaucetCoins` excludes every **held** reserved outpoint (`activeReservations`), then
`createAuthorised` inserts the claim **and** its reservation rows in one transaction; a
reservation PK conflict rolls back and the handler retries with fresh coins. Reservations are
durable — a crash cannot orphan a coin into "reserved in RAM only".

**A reservation is released ONLY by `retireReservations()`, which is safe ONLY on an
AUTHORITATIVE CONFIRMED/CONFLICTED result** (our exact tx confirmed, or the input proven spent
by a different tx). No timeout, no restart, no missing/stale explorer result and no
UNCERTAIN/FAILED_SAFE state ever returns a reserved input to coin selection. Because the current
reconciliation source is a **non-authoritative external explorer (RT-2A), nothing is retired at
all** — `activeReservations()` returns the full set, and retirement waits for an own-node
adapter. This makes the classic double-spend-race impossible:

| Claim state | Reservation |
|---|---|
| AUTHORISED / SIGNED / BROADCASTING / SEEN | **held** |
| UNCERTAIN | **held** (an uncertain tx may in fact have broadcast) |
| FAILED_SAFE | **held** unless a separate authoritative/manual resolution proves release is safe |
| CONFIRMED | retire-able only on **authoritative** confirmation; audit linkage kept on the claim |
| CONFLICTED | retire-able only when an **authoritative** source proves the outpoint is spent by another tx; **never** auto-builds a replacement |

Retirement preserves history: the claim row keeps `reserved_outpoints` + `local_txid` + final
`state` even after its reservation rows are removed.

> Failure sequence this prevents: *TX-A broadcast → response lost → claim UNCERTAIN →
> reservation expires → coin reused → TX-B built → TX-A later confirms.* The reservation never
> expires on UNCERTAIN, so step 3 onward cannot happen (proved in `rt2_reservation.test.mjs`).

## Recovery (auto, no client re-request)
On startup and every 30 s, `recoverAll` drives each non-terminal claim via `processClaim`:
| State on restart | Action |
|---|---|
| AUTHORISED | build+sign → SIGNED → reconcile → broadcast (Decision 1: auto-complete) |
| SIGNED | reconcile; broadcast the EXACT raw_tx only if absent |
| BROADCASTING | **reconcile first** (ambiguous); rebroadcast same bytes only if absent |
| SEEN | reconcile for confirmation/conflict |
| UNCERTAIN | bounded reconcile; resolve to SEEN/CONFIRMED/CONFLICTED or keep UNCERTAIN |
Reconciliation is the arbiter: our txid found → SEEN/CONFIRMED; a reserved input spent by a
**different** txid → CONFLICTED; input spent by **our** txid → SEEN; otherwise absent. After
`maxBroadcasts`, a still-absent tx → UNCERTAIN (never optimistic, never a replacement).

**RT-2A — external explorer is ADVISORY, not authoritative.** The testnet reconciliation source
is mempool.space (`realChain().authoritative === false`). It may be stale, rate-limited, behind
the network, inconsistent or wrong, so it may **observe** (drive SEEN) or trigger a rebroadcast
of the EXACT stored bytes (idempotent — same txid), but it must **never** justify a second/
replacement payment or release a reserved input. Missing-from-explorer is treated as
"not-yet-indexed" (rebroadcast same bytes, else UNCERTAIN) — never as "never broadcast". Only an
**authoritative node** for the network (Bitcoin Core / own node) may resolve an uncertain case
to "safe" or retire a reservation; until then the safe state is UNCERTAIN (fail closed). The
preferred long-term design is to reconcile testnet4 against our own testnet4 Core node.

## Idempotency & HTTP
| Situation | Code | Body |
|---|---|---|
| new claim, reached SEEN/CONFIRMED | 200 | `{claimId, state, txid, explorer}` |
| new claim, still in-flight/UNCERTAIN | 202 | `{claimId, state, txid?}` |
| duplicate (same entitlement) | 200/202 | the **existing** claim (never a 2nd payout) |
| `Idempotency-Key` replay (same request) | 200/202 | the same claim |
| `Idempotency-Key` reused, different request | 409 | `{error, claimId}` |
| CONFLICTED / FAILED_SAFE | 200 | `{claimId, state, note:'manual review'}` |
| per-IP hourly limit / global daily cap | 429 | rate-limit error |
| ledger unavailable / breaker tripped | 503 | paused |

Duplicates are **never** a blind 429 — 429 is only for genuine per-IP / global-daily limits.

## Crash-point → recovery (proved in `rt2_crash.test.mjs`)
| Crash at | Restart result |
|---|---|
| before AUTHORISED commit | claim never existed → client may retry |
| after AUTHORISED commit | recovery auto-completes → one tx |
| after sign, before SIGNED persist | re-sign is deterministic → same txid → one tx |
| after SIGNED persist | reconcile → broadcast exact raw_tx → SEEN |
| after BROADCASTING persist, before send | reconcile absent → broadcast once |
| after send, before verify/SEEN | reconcile finds it → SEEN (no rebroadcast) |
| node accepted but call threw (ambiguous) | UNCERTAIN → reconcile → SEEN |
In every case: **exactly one distinct broadcast txid, or an explicit fail-closed state — never
two payments.**

## Dashboard states
`RUNNING` · `TRIPPED` (breaker) · `DEGRADED` (ledger down → payouts paused) · `STALE`
(telemetry old) · `UNKNOWN` (telemetry unreadable). A "Claim ledger" panel shows per-state
counts, oldest non-terminal age, recovery-worker health, and highlights UNCERTAIN/CONFLICTED/
FAILED_SAFE for manual attention. Telemetry passes through the RT-3 redaction (no secrets).

## Operator actions
- Inspect: dashboard `/api`, or `sqlite3 .secrets/faucet-claims.db 'select state,count(*) from claims group by state'`.
- `CONFLICTED`/`FAILED_SAFE`/long-lived `UNCERTAIN` need manual review (no auto-replacement).
- Ledger DOWN → payouts are already paused; fix the DB / disk, then restart the service.
- **Backup:** do not copy a live WAL DB naively. Use `sqlite3 .secrets/faucet-claims.db ".backup '/path/backup.db'"` (consistent), or stop the service before copying `*.db*`.

## Migration
There is **no** reliable historic durable claim record (previous cooldowns were in-memory
only). The ledger starts empty; prior in-memory state is intentionally NOT imported (we do not
invent past claims). First run creates `schema_version=2`. A `schema_version=1` DB is migrated
in place on open (RT-2B): the global `uq_clientkey` index is dropped and the network-scoped
`uq_clientkey_net` created; the entitlement index is untouched.

## Security invariants (mapped to tests)
I1 durable AUTHORISED survives restart (ledger/crash) · I2 one (network,canon,day) → one claim
(crash test race) · I3 no new tx after SIGNED (crash test distinctTx=1) · I4 local txid from
bytes (processor guard + FAILED_SAFE test) · I5 external txid must equal local (crash test) ·
I6 ambiguous → UNCERTAIN (crash test) · I7 conflict → CONFLICTED, no replacement (crash test) ·
I8 DB failure stops payouts (server 503 + DEGRADED) · I9 durable reservations (ledger test) ·
I10 retries converge on the original claim (live idempotency) · I11 mainnet disabled (guard) ·
I12 UNKNOWN/STALE/UNCERTAIN/DEGRADED never RUNNING (dashboard tests).
