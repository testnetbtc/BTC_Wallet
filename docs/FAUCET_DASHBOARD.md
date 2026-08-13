# Faucet operational / security dashboard — design & scope

A **read-only** operational dashboard for the faucet + surrounding services. It exists to
answer "is anything wrong right now?" at a glance: breaker state, how close each aggregate
metric is to its trip threshold, faucet liquidity, recent activity, node health, and
service heartbeats. It performs **no** actions.

Files: [`faucet/telemetry.mjs`](../packages/bitcoin/faucet/telemetry.mjs) (pure aggregation,
redaction, warning levels — unit-tested), [`faucet/dashboard.mjs`](../packages/bitcoin/faucet/dashboard.mjs)
(localhost server + self-contained HTML), producer additions in
[`faucet/server.mjs`](../packages/bitcoin/faucet/server.mjs), tests in
[`test/dashboard.test.mjs`](../packages/bitcoin/test/dashboard.test.mjs).

## Topology

```
faucet (8790)  --writes-->  .secrets/faucet-telemetry.json  (breaker status, recent
   |                                                          payouts/rejects, reserved
   |                                                          count, uptime, last payout)
   |  .secrets/breaker-trips.log (append-only trip/reset log)
   v
dashboard (127.0.0.1:8793, SEPARATE read-only service)
   reads: telemetry file · trips log · heartbeat files · node RPC (read-only methods)
   fetches: faucet /info (balances) · mempool.space UTXO counts (testnet is not on our node)
   serves: GET /      -> self-contained HTML (nonce-CSP, no external deps, no chart libs)
           GET /api   -> curated JSON (redacted); GET /healthz -> ok
           anything else / any non-GET -> 405
```

The faucet **produces** a telemetry snapshot to a local file; the dashboard is a distinct
process that only ever **reads**. There is no path from the dashboard back into the faucet,
wallet, node-write, or breaker reset. Bound to `127.0.0.1` — reach it via SSH tunnel
(`ssh -L 8793:localhost:8793 …`); it is intentionally **not** on the public Cloudflare tunnel.

## What it shows

- **Breaker state:** RUNNING / PAUSED (tripped-latch) — with the trip reason if tripped.
- **Six aggregate metrics, current value vs configured limit**, each with a warning level:
  claims/min, sats/min, distinct destinations/min, UTXOs/min, fees/min, rejected-or-failed/min.
- **Warning levels (display-only, never feed back into the breaker):**
  `normal` (<50% of limit) · `elevated` (50–80%) · `near-limit` (80–100%) · `tripped` (latched).
- **Faucet balances** per network + **available / reserved UTXO counts**.
- **Recent payouts** (time, network, destination, sats, state) and **recent rejected claims**
  (time, kind) — from the faucet's ring buffers.
- **Recent breaker trips** with reason (from `breaker-trips.log`).
- **Bitcoin node/RPC health:** blocks, headers, verification progress, peers, mempool size
  (read-only RPC; **credentials never leave the box or appear in output**).
- **Service heartbeats:** faucet, Nostr bot, Telegram notify bot, paper-trading, HL X-ray —
  each with age and a stale flag.
- **Last successful payout time** and **faucet uptime / last restart**.

## Security model (the point of this being a separate phase)

1. **Read-only, by construction.** Only `GET` is handled; every other method and unknown path
   returns `405`/`404`. No reset, payout, wallet, signing, RPC-write, or admin route exists.
   Node RPC is restricted to a hard **allowlist** of read-only methods
   (`getblockchaininfo`, `getnetworkinfo`, `getmempoolinfo`, `getblockcount`, `uptime`).
2. **No secret ever leaves the box.** The `/api` payload is built from a curated allowlist of
   fields, then passed through a defensive `redact()` that strips any key matching
   `/pass|secret|token|mnemonic|seed|priv|rpcuser|apikey|cookie|auth/i` at any depth — so even
   if an upstream file gains a secret field, it cannot surface. A test asserts known secret
   values never appear in `/api` or the HTML.
3. **Everything user/log/explorer-derived is escaped.** The HTML builds every dynamic value
   with `textContent`/`createElement` — never `innerHTML` with data — so a hostile address,
   reject-kind, or trip reason renders as inert text. A jsdom test injects `<img onerror>` in an
   address and asserts no element is created.
4. **CSP is not weakened.** The dashboard is its own page with a strict, per-response
   **nonce** CSP: `default-src 'none'; script-src 'nonce-…'; style-src 'unsafe-inline';
   connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none';
   frame-ancestors 'none'`. No external scripts, styles, fonts, or chart libraries.
5. **No heavy frontend stack.** Vanilla JS + CSS; bars and sparklines are hand-rolled with
   CSS / inline SVG. Zero npm frontend dependencies.
6. **Local-first telemetry.** Breaker state, node health, and heartbeats are read locally.
   The only external source is mempool.space for **testnet** balances/UTXO counts, because our
   node is mainnet-only — noted here as an honest, unavoidable exception.

## Explicitly out of scope

No control actions of any kind (the breaker reset stays a CLI + `systemctl reload`), no
historical time-series storage, no auth/login (localhost + SSH tunnel is the boundary), no
public exposure.

## Tests

`test/dashboard.test.mjs` (in the CI suite): warning-level thresholds; `redact()` removes
secret-shaped keys and never emits seeded secret values; the aggregated `/api` payload built
from a fixture containing secrets is clean; heartbeat staleness; the breaker→metric-view
mapping (value/limit/level for all six); and a jsdom render test proving a malicious address
is inert (no injected node). Live verification: start the service, confirm `/api` structure,
absence of secrets, node health present, heartbeats present, and `405` on non-GET.
