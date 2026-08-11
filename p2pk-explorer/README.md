# Olesia P2PK Explorer

The block explorer for **P2PK (pay-to-public-key)** transactions — the ones normal
explorers can't find (no address to search by). Live at **olesia.io/p2pk**.

- `build.mjs` — builds `landing/p2pk/data/{p2pk.json,meta.json}` from a curated
  seed of famous early P2PK txs (fetched by txid from the public API) plus a
  forward scan of new blocks from our own bitcoind. `--scan-recent N` also scans
  the last N blocks the (pruned) node holds.
- `update.sh` — daily: rebuild data + deploy the landing site to production.
- The page itself (`landing/p2pk/index.html`) is static + client-side; it also
  offers a live "paste any txid" P2PK decoder.

## Daily cron (Europe/London)
```
30 3 * * * cd /home/faucet/BTC_Wallet && CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... ./p2pk-explorer/update.sh >> p2pk-explorer/update.log 2>&1
```

## Backfill (Phase B, pending)
Full genesis→today import via the BigQuery public dataset
(`bigquery-public-data.crypto_bitcoin.outputs WHERE type='pubkey'`), merged into
`p2pk.json`. Our own node is pruned and cannot walk history.
