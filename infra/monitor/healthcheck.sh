#!/bin/bash
# Olesia health monitor — runs every few minutes via olesia-healthcheck.timer.
# systemd already restarts on crash; this also catches a HUNG process (running but
# not serving / not heartbeating) and self-heals it. Restarts are logged.
set -u
LOG=/home/faucet/BTC_Wallet/infra/monitor/health.log
HB=/home/faucet/BTC_Wallet/packages/bitcoin/.secrets/nostr-heartbeat.json
STALE=300   # seconds; bot rewrites its heartbeat every ~60s
log() { echo "$(date -Iseconds) $1" >>"$LOG"; }

# 1) Faucet: must answer /info over HTTP
if ! curl -sf -m 8 http://127.0.0.1:8790/info >/dev/null 2>&1; then
  log "faucet /info unhealthy -> restart olesia-faucet"
  systemctl restart olesia-faucet
fi

# 2) Nostr bot: heartbeat file must be fresh (proves the event loop is alive)
if [ -f "$HB" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$HB") ))
  if [ "$age" -gt "$STALE" ]; then
    log "bot heartbeat stale ${age}s -> restart olesia-nostr-bot"
    systemctl restart olesia-nostr-bot
  fi
else
  if ! systemctl is-active --quiet olesia-nostr-bot; then
    log "bot inactive, no heartbeat -> restart olesia-nostr-bot"
    systemctl restart olesia-nostr-bot
  fi
fi
exit 0
