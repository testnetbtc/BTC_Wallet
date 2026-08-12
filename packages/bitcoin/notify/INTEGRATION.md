# Folding chainwatch's detectors into the platform

The platform bot (`bot.mjs`) owns the Telegram connection and delivers two kinds
of subscription: **personal** alerts (a user's own addresses, price, fees,
blocks — sourced from our node) and **public intelligence feeds** produced by
chainwatch's detectors. Producers and delivery are decoupled through a localhost
HTTP intake so the feeds are multi-tenant (per-user opt-in + size filters),
not a single broadcast channel.

## The contract

`POST http://127.0.0.1:<intakePort>/event`
Header `x-intake-token: <intakeToken>`  (both live in `.secrets/notify-node.json`)

```json
{
  "feed":  "coldcard | whales | satoshi | ofac",
  "key":   "<txid or unique dedup id>",
  "btc":   123.4,                       // required for filtered feeds (whales)
  "title": "one-line headline",
  "body":  "optional detail",
  "link":  "https://mempool.space/tx/<txid>"   // optional
}
```

Response `{"ok":true,"delivered":N}`. Unknown feed → 422. Bad/no token → 401.
Dedup is automatic per (feed,key) per subscriber, so re-emitting is safe.

## Feed keys ↔ detectors

| feed       | produced by                        | btc filter |
|------------|------------------------------------|------------|
| `coldcard` | indexer.py (COLDCARD_SOURCES hits) | no         |
| `whales`   | sweep_detector.py whale_exchange   | **yes**    |
| `satoshi`  | sweep_detector.py satoshi_era/p2pk | no         |
| `ofac`     | indexer.py OFAC-SDN movements      | no         |

## Wiring (go-live step, additive — does not remove channel publishing)

1. Put `OLESIA_INTAKE_URL` and `OLESIA_INTAKE_TOKEN` in the chainwatch service
   environment (systemd `Environment=` or config.json), matching notify-node.json.
2. Copy `feed_client.py` next to the detectors and, at each existing alert site,
   add one line, e.g. in the whale→exchange path:
   `feed_client.emit("whales", txid, title=headline, btc=amount, link=url)`
3. Detectors keep their current behaviour; this is a parallel fire-and-forget
   call that never raises into the detector and short-times-out if the platform
   is down.

## Why one bot / one token

Telegram allows only one process to long-poll a token. The platform bot becomes
the sole poller; the chainwatch agent's interactive commands (`/check`) either
move into the platform bot or are retired. The bot may still post a public
mirror to `@chainwatch_btc` (send-only, no polling conflict) if you want to keep
the channel.
