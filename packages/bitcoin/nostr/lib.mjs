// Minimal, dependency-light Nostr client — schnorr events + a small relay pool.
// Built on the same audited primitives as the wallet (@noble, @scure); no nostr-tools.
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';

export const pubkeyOf = (privHex) => bytesToHex(schnorr.getPublicKey(hexToBytes(privHex)));

// NIP-19 bech32 encodings
export const npub = (pubHex) => bech32.encode('npub', bech32.toWords(hexToBytes(pubHex)), 200);
export const nsec = (privHex) => bech32.encode('nsec', bech32.toWords(hexToBytes(privHex)), 200);
export function decodeNip19(s) {
  const { prefix, words } = bech32.decode(s, 200);
  return { prefix, hex: bytesToHex(new Uint8Array(bech32.fromWords(words))) };
}

// Build + sign an event. `now` is unix seconds (caller supplies the clock).
export function finalize({ kind, content = '', tags = [] }, privHex, now) {
  const pubkey = pubkeyOf(privHex);
  const created_at = now;
  const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, pubkey, created_at, kind, tags, content]))));
  const sig = bytesToHex(schnorr.sign(id, hexToBytes(privHex)));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

export function verify(ev) {
  try {
    const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))));
    return id === ev.id && schnorr.verify(ev.sig, ev.id, ev.pubkey);
  } catch { return false; }
}

// A tiny relay pool: connects to N relays, auto-reconnects, publishes to all,
// and streams matching events to a handler. Deliberately simple.
export class RelayPool {
  constructor(urls, { onEvent, log = () => {} } = {}) {
    this.urls = urls; this.onEvent = onEvent; this.log = log;
    this.sockets = new Map(); this.subs = []; this.closed = false;
  }
  connect() { for (const u of this.urls) this._open(u); }
  _open(url) {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.log(`relay ${url} ctor: ${e.message}`); return this._retry(url); }
    this.sockets.set(url, ws);
    ws.addEventListener('open', () => { this.log(`relay open ${url}`); for (const s of this.subs) ws.send(JSON.stringify(['REQ', s.id, s.filter])); });
    ws.addEventListener('message', (m) => {
      let data; try { data = JSON.parse(m.data); } catch { return; }
      if (data[0] === 'EVENT' && this.onEvent) this.onEvent(data[2], url);
    });
    ws.addEventListener('close', () => { this.sockets.delete(url); this._retry(url); });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  }
  _retry(url) { if (!this.closed) setTimeout(() => this._open(url), 5000); }
  subscribe(id, filter) { this.subs.push({ id, filter }); for (const ws of this.sockets.values()) if (ws.readyState === 1) ws.send(JSON.stringify(['REQ', id, filter])); }
  publish(ev) {
    const msg = JSON.stringify(['EVENT', ev]); let sent = 0;
    for (const ws of this.sockets.values()) if (ws.readyState === 1) { try { ws.send(msg); sent++; } catch {} }
    return sent;
  }
  close() { this.closed = true; for (const ws of this.sockets.values()) try { ws.close(); } catch {} }
}

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostr.mom',
];
