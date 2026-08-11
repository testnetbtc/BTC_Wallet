// Olesia Nostr faucet bot. Watches for public mentions like "testnet4 tb1q…",
// dispenses a small drip via the local faucet, and replies with the tx link.
// Anti-abuse: one claim per Nostr account per 24h (here) + per-address + global
// caps (faucet) + a tiny fixed drip + worthless testnet coins. Sybil-proofing is
// inherently limited (npubs are free), so the global cap is the real backstop.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as btc from '@scure/btc-signer';
import { net } from '../src/networks.js';
import { RelayPool, DEFAULT_RELAYS, finalize, pubkeyOf, npub, verify } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const secret = (f) => JSON.parse(readFileSync(join(HERE, '..', '.secrets', f), 'utf8'));
const PRIV = secret('nostr.json').priv;
const PUB = pubkeyOf(PRIV);
const INTERNAL = secret('internal.json').faucetInternalToken;
const FAUCET = 'http://127.0.0.1:8790';
const STATE_FILE = join(HERE, '..', '.secrets', 'nostr-state.json');
const PER_ACCOUNT_MS = 24 * 3600 * 1000;
const now = () => Math.floor(Date.now() / 1000);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// persisted state: last claim time per pubkey + processed event ids (bounded)
let state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { claims: {}, seen: [] };
const seen = new Set(state.seen);
const saveState = () => { state.seen = [...seen].slice(-4000); try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { log('state save failed', e.message); } };

function parseRequest(text) {
  const t = (text || '').toLowerCase();
  let network = /testnet3|tn3|\bt3\b/.test(t) ? 'testnet3' : (/testnet4|tn4|\bt4\b|signet/.test(t) ? (/signet/.test(t) ? null : 'testnet4') : 'testnet4');
  // signet not dispensed by this faucet -> null network handled below
  const tokens = (text || '').split(/[\s,]+/);
  for (const tok of tokens) {
    const c = tok.trim().replace(/[.,;:]+$/, '');
    if (c.length < 20) continue;
    try { btc.Address(net('testnet4').btc).decode(c); return { network, address: c }; } catch {}
  }
  return { network, address: null };
}

async function claim(network, address) {
  const r = await fetch(FAUCET + '/claim', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-faucet-internal': INTERNAL },
    body: JSON.stringify({ network, address }),
  });
  return { ok: r.ok, body: await r.json() };
}

const reply = (pool, to, text) => {
  const ev = finalize({ kind: 1, content: text, tags: [['e', to.id, '', 'reply'], ['p', to.pubkey]] }, PRIV, now());
  const n = pool.publish(ev);
  log(`replied to ${to.id.slice(0, 8)} via ${n} relays`);
};

async function handle(pool, ev) {
  if (!ev || ev.pubkey === PUB || seen.has(ev.id)) return;      // skip self + dupes
  if (!(ev.tags || []).some((t) => t[0] === 'p' && t[1] === PUB)) return; // must actually mention us
  if (!verify(ev)) return;
  seen.add(ev.id);
  const { network, address } = parseRequest(ev.content);
  if (/signet/i.test(ev.content) && !address) { reply(pool, ev, 'This faucet dispenses Testnet3 and Testnet4 only. Try: "testnet4 tb1q…". More at https://olesia.io/faucet'); saveState(); return; }
  if (!address) { reply(pool, ev, 'Hi! Send me a testnet address and I\'ll fund it, e.g. "testnet4 tb1q…". New to this? https://olesia.io/learn'); saveState(); return; }
  const last = state.claims[ev.pubkey] || 0;
  if (Date.now() - last < PER_ACCOUNT_MS) {
    const hrs = Math.ceil((PER_ACCOUNT_MS - (Date.now() - last)) / 3600000);
    reply(pool, ev, `You already claimed recently — one per account every 24h so everyone can learn. Try again in ~${hrs}h. 🙏`);
    saveState(); return;
  }
  log(`claim ${network} ${address} for ${npub(ev.pubkey).slice(0, 16)}…`);
  const { ok, body } = await claim(network, address);
  if (ok) {
    state.claims[ev.pubkey] = Date.now();
    const url = net(network).explorer + body.txid;
    reply(pool, ev, `✓ Sent ${(body.amount / 1e8).toFixed(3)} tBTC on ${network} to ${address}\n${url}\nOpen it in the wallet: https://app.olesia.io · Learn: https://olesia.io/learn`);
  } else {
    reply(pool, ev, `Couldn't send: ${body.error || 'try again later'}. Faucet status: https://olesia.io/faucet`);
  }
  saveState();
}

function publishProfile(pool) {
  const profile = {
    name: 'faucet', display_name: 'Olesia · Bitcoin Faucet',
    about: 'Free Bitcoin testnet faucet + learn-by-doing wallet. Mention me with a network and address — e.g. "testnet4 tb1q…" — and I\'ll send practice coins (one per account / 24h). Educational only; testnet coins have no value. https://olesia.io',
    website: 'https://olesia.io',
    picture: 'https://olesia.io/olesia-icon.png',
    nip05: 'faucet@olesia.io',
  };
  pool.publish(finalize({ kind: 0, content: JSON.stringify(profile), tags: [] }, PRIV, now()));
  // NIP-65 relay list
  pool.publish(finalize({ kind: 10002, content: '', tags: DEFAULT_RELAYS.map((r) => ['r', r]) }, PRIV, now()));
  log('published profile (kind 0) + relay list (kind 10002)');
}

const pool = new RelayPool(DEFAULT_RELAYS, { log, onEvent: (ev) => handle(pool, ev).catch((e) => log('handle err', e.message)) });
pool.connect();
log(`olesia nostr faucet bot up as ${npub(PUB)}`);
setTimeout(() => publishProfile(pool), 2500);
// only react to fresh mentions (avoid replaying history); refresh subscription window periodically
pool.subscribe('mentions', { kinds: [1], '#p': [PUB], since: now() - 120 });
setInterval(saveState, 60000).unref();
// liveness heartbeat for the health monitor (file mtime = last-alive)
const HEARTBEAT = join(HERE, '..', '.secrets', 'nostr-heartbeat.json');
const beat = () => { try { writeFileSync(HEARTBEAT, JSON.stringify({ t: Date.now(), npub: npub(PUB), relays: DEFAULT_RELAYS.length })); } catch {} };
beat(); setInterval(beat, 60000).unref();
process.on('SIGTERM', () => { saveState(); pool.close(); process.exit(0); });
