# Build brief — Olesia Telegram Alerts (olesia.io/telegram)

A build spec for the agent implementing custom Bitcoin notifications over Telegram.
The **front-end scaffold already exists**: `landing/telegram/index.html` (styled, deployed
to preview). This brief covers the **bot + backend** that make it real.

## Goal

A Telegram bot that sends users custom, **watch-only** Bitcoin alerts. Users paste a
public address or xpub, a price level, or a fee target — never a seed or private key. Four
alert types (all requested):

1. **Address activity** — a watched address (or every address under an xpub, gap-limit 20)
   receives/sends coins; and on first confirmation.
2. **Price alerts** — BTC crosses a user-set USD level (above/below; one-shot or repeating).
3. **Fee / mempool** — recommended sat/vB drops below (or rises above) a user target.
4. **New blocks & halving** — each new block, and countdowns to the next difficulty
   adjustment / halving.

## Where things live

| Thing | Path / location |
|---|---|
| Front-end page (done) | `landing/telegram/index.html` — deployed to `preview.olesia-landing.pages.dev/telegram/` |
| This brief | `docs/TELEGRAM_NOTIFICATIONS_BRIEF.md` |
| Reusable derivation (xpub → addresses) | `packages/bitcoin/src/send.js` — `deriveAt`, `discoverAccount`; `packages/bitcoin/src/wallet.js` — `parseExtendedKey`, `accountXpub` |
| Existing small-service pattern to copy | `packages/bitcoin/faucet/server.mjs` (node http server behind a Cloudflare tunnel, secrets in `packages/bitcoin/.secrets/`, rate limits, heartbeat) |
| Precedent bot | the Nostr faucet bot in this repo (see the `olesia-faucet-nostr` project notes) |
| CSP for the page | `tools/harden-landing.mjs` — the `/telegram/*` entry sets `script-src`/`connect-src`; re-run after changing the page's inline script or adding fetch hosts |

## Suggested architecture

```
Telegram  <——bot API——>  olesia-notify service (node, on the VPS, behind a CF tunnel)
                                │
                                ├── subscriptions store (SQLite): who watches what
                                ├── watchers (poll or websocket):
                                │     • address:  mempool.space (REST + /api/v1/ws) or our own node
                                │     • price:    mempool.space /api/v1/prices (cache)
                                │     • fees:     mempool.space /api/v1/fees/recommended
                                │     • blocks:   mempool.space /api/v1/ws (block events)
                                └── dispatcher: on trigger -> sendMessage(chat_id, text)
```

- **Reuse the faucet-server shape** (`server.mjs`): a tiny node service, secrets in
  `packages/bitcoin/.secrets/` (mode 600, gitignored — put the **bot token** there, e.g.
  `telegram.json`), a Cloudflare tunnel to a subdomain (e.g. `notify.olesia.io`), a
  heartbeat file, and per-user rate limits.
- **Bot framework:** `grammy` or `node-telegram-bot-api` (add to a new package, e.g.
  `packages/notify/`). Long-polling is simplest; a webhook (via the tunnel) scales better.
- **Data sources:** default to mempool.space's REST + websocket (`/api/v1/ws` supports
  `track-address`, block, and mempool-fee subscriptions). For lower third-party exposure,
  the operator's own node (`api.olesia.io` / bitcoind) can back address + block watching.

## Data model (SQLite sketch)

```
users(chat_id PK, created_at, tz, muted_until)
subs(id PK, chat_id FK, type, params_json, repeat, last_fired_at, active)
   type ∈ {address, price, fee, block}
   params_json examples:
     address: { "watch": "tb1q…" | "xpub…", "network": "mainnet", "direction": "any|in|out" }
     price:   { "op": "above|below", "usd": 100000, "repeat": false }
     fee:     { "op": "below", "sat_vb": 5 }
     block:   { "every": true } | { "milestone": "halving|difficulty" }
seen(sub_id, key)   -- dedupe: e.g. a txid or block height already alerted
```

## Bot commands (suggested)

`/start` · `/watch <address|xpub>` · `/price <above|below> <usd>` · `/fee below <sat/vb>` ·
`/blocks on` · `/list` · `/mute 2h` · `/remove <id>` · `/help`. Mirror these as buttons.

## Hard rules (match Olesia's ethos — enforce in the bot)

- **Watch-only only.** If a message looks like a **mnemonic (12/24 BIP-39 words) or a
  private key / WIF**, refuse it, delete it if possible, and warn the user never to share a
  seed. Accept only addresses and xpubs. The page already states this; the bot must enforce.
- **No custody, no signing** — this service never holds keys and cannot move funds.
- **Rate-limit** per chat_id; cap watched items per user; validate addresses/xpubs with the
  existing `packages/bitcoin` helpers before storing.
- **Privacy note:** watching an address/xpub means the service (and its data source) learns
  those addresses. State this in `/start`. Prefer the operator's own node for address data
  to reduce third-party exposure.

## Front-end wiring (small changes when the bot exists)

1. In `landing/telegram/index.html`, point the **"Connect Telegram"** button at the bot
   deep link (`https://t.me/<YourBot>?start=…`), enable it, and (optionally) POST the
   previewed alert-type selection to the service to pre-seed the chat.
2. If the page gains a `fetch` to the service, add that host to the `/telegram/*`
   `connect-src` in `tools/harden-landing.mjs` and re-run it (keeps the CSP strict).
3. Register the Telegram bot with Cloudflare Turnstile if you add a web signup form
   (the faucet already uses Turnstile — reuse that pattern).

## Definition of done

Bot live; the four alert types working end-to-end with dedupe and mute; watch-only enforced
(seed/WIF rejected); per-user limits; a heartbeat + a daily-restart cron like the other
services; the page's Connect button live; CSP updated and re-verified
(`node tools/verify-headers.mjs preview`).
