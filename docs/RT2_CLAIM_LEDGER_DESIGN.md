# RT-2 — Durable claim ledger & payout state machine (DESIGN — not implemented)

**Status: PROPOSAL for review. No code written.** Per the operator's instruction, RT-2 is
designed and reviewed *before* implementation because it touches payout correctness.

## The finding (recap)
The faucet keeps **no persistent claim ledger**; per-IP/per-address/global caps and the UTXO
reservation are in-memory, so any restart resets them → an already-paid address can re-claim
and the "daily" global cap resets (RT-2, Medium; would be High on mainnet).

## The anti-goal (operator's warning, taken seriously)
> Don't solve persistence by merely persisting the existing Maps.

Correct. Persisting the Maps would make limits durable but would **not** make the payout
*idempotent*, and could introduce a nastier failure: after a crash you must be able to tell
whether a claim was **never authorised**, **authorised but not broadcast**, **broadcast
successfully**, or **uncertain** — and act without double-paying or double-spending a reserved
UTXO. The design below is built around that state machine, not around a persisted counter.

## Claim state machine

```
                (idempotency key: network+address+day)
NEW ──insert(AUTHORISED) durable──▶ AUTHORISED
                                      │  reserve UTXO (durable) + build+sign; store txHex+txid
                                      ▼
                                   SIGNED ──mark BROADCASTING (durable, write-ahead)──▶ BROADCASTING
                                                                                          │ broadcast(txHex)
                                              ┌───────────────────────────┬───────────────┤
                                              ▼                           ▼               ▼
                                         BROADCAST_OK               UNCERTAIN         (txid mismatch)
                                     (txid seen/echoed)      (network error/timeout/    → ABORT (RT-5),
                                                              crash mid-broadcast)        row stays SIGNED
```

Terminal-only-after-reality: a row is **never** marked `BROADCAST_OK` or `FAILED` on optimism.
An ambiguous broadcast → `UNCERTAIN`, resolved by reconciliation against the chain.

## Write-ahead ordering (what is durable *before* each side effect)
1. **Before committing to pay:** `INSERT` the claim row `AUTHORISED` with the idempotency key,
   inside the same transaction that checks the per-address/day uniqueness and the global daily
   count. If the unique constraint fires → `429` (already claimed) — **atomic, survives restart**.
   This is the durable rate-limit slot.
2. **Before broadcast:** reserve the UTXO **durably** (store the chosen outpoint on the row),
   build+sign, and store the exact `txHex` + built `txid`; set `BROADCASTING`. Now recovery knows
   *exactly* what tx to (re)broadcast.
3. **Broadcast**, then set `BROADCAST_OK` (txid verified per RT-5) or `UNCERTAIN`.

## Idempotency
- **Uniqueness / caps:** a `UNIQUE(network, address, day)` index makes a duplicate claim's insert
  fail deterministically (fixes both the restart-reset and any future multi-writer race). The
  global daily cap is `SELECT count WHERE day=today` inside the same transaction.
- **Retries return, don't re-pay:** a repeat of the same key returns the *existing* row's result
  (its txid if broadcast, or resumes it if incomplete) — it never starts a second payout.
- **Recovery re-broadcasts the SAME bytes:** on restart, non-terminal rows re-broadcast the
  **stored `txHex`** (identical txid) — re-sending an already-accepted tx is a harmless
  "already-in-mempool", so it can never double-spend the reserved UTXO or double-pay.

## Crash recovery — per stage (matches the operator's list)
| Crash point | Durable state | Recovery action | Double-pay? |
|---|---|---|---|
| before AUTHORISED insert | none | claim never happened; client may retry | No (never paid) |
| AUTHORISED, no tx yet | `AUTHORISED` | complete it (reserve+sign+broadcast) **or** the next same-key request resumes it | No — address is durably rate-limited |
| SIGNED / BROADCASTING | `BROADCASTING` + stored txHex | reconcile stored txid vs chain; if unknown, **re-broadcast the same bytes** | No — same txid, idempotent |
| after broadcast, before OK write | `BROADCASTING` / `UNCERTAIN` | reconcile: txid in mempool/confirmed → `BROADCAST_OK` | No |
| after `BROADCAST_OK` | terminal | nothing | No |

**Reconciliation (startup + periodic):** for every non-terminal row, query the chain for the
stored txid (mempool/confirmed?) and whether the reserved input is spent. Resolve to
`BROADCAST_OK` if seen; **only** mark retryable/failed if the tx is definitively absent *and* the
reserved input is still unspent after a grace period. Never resume by minting a *new* tx.

## Storage
- **SQLite via `node:sqlite`** (already used by the notify bot) — single-file, transactional,
  gives the atomic insert+cap check for free. DB lives in `.secrets/` (600, gitignored) or a
  dedicated data dir with `ReadWritePaths`.
- Schema (sketch):
  `claims(id PK, key UNIQUE, network, address, day, state, outpoint, tx_hex, txid, sats,
   created_at, updated_at)` + index on `(day)` for the global cap and on `(state)` for recovery.

## What stays in-memory vs durable
- **Durable:** the claim ledger (this design), the breaker **trip latch** (already durable +
  atomic after RT-4).
- **In-memory (intentionally):** the breaker's rolling 60 s **velocity window** — it's a
  short-horizon rate signal; losing it on restart is acceptable and the latch is the durable part.
  The per-IP hourly throttle can stay in-memory (short horizon) or move to the ledger; the
  per-address/day and global/day caps **must** become durable (that's the RT-2 core).

## New failure modes this introduces — and the mitigations
- **DB corruption / disk full:** the payout path must **fail closed** if the ledger write fails
  (no pay without a durable AUTHORISED record). Same atomic-write discipline as RT-4.
- **Stuck `BROADCASTING`/`UNCERTAIN` rows:** bounded by reconciliation + a grace-period sweep;
  surfaced on the dashboard so they can't hide.
- **Ledger vs chain divergence:** the chain is the arbiter; the ledger is reconciled to it, never
  the reverse (consistent with the existing "never let a cache be the source of truth for money").
- **Backup/DR:** the DB becomes state to back up; document restore.

## Test plan (before it ships)
A **crash-injection harness**: an injectable "crash-after-<stage>" hook that aborts the payout at
each state transition; after each, restart and assert the invariants — exactly-once payout, no
reused/spent UTXO, no lost rate-limit slot, no stuck row, and no `BROADCAST_OK` for a tx that
never landed. Plus a concurrency test (same key in parallel → exactly one AUTHORISED) and a
reconciliation test (UNCERTAIN row resolved correctly against a stubbed chain).

## Open questions for the operator (please decide before implementation)
1. **Recovery policy for `AUTHORISED`-but-never-broadcast:** auto-complete the payout on restart,
   or leave it (fail-closed: address is rate-limited but got no coins, awaiting its own retry)?
2. **`node:sqlite` vs an append-only JSON journal** — SQLite is cleaner/atomic; the journal is
   dependency-free. Preference?
3. **Scope:** keep it testnet-only for now, or design the schema/reconciliation to be
   mainnet-ready from the start (affects grace periods and confirmation depth)?
4. **Idempotency key granularity:** `(network, address, day)` as proposed, or also accept a
   client-supplied idempotency header for exactly-once client retries?
