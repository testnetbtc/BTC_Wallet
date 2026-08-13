// Olesia faucet — dispenses small amounts of testnet3/testnet4 coins to learners.
// Funded from the operator's own testnet stash (worthless coins). Localhost-only;
// a Cloudflare Tunnel maps https://faucet.olesia.io -> here. Abuse protection:
// per-IP + per-address rate limits, a fixed small drip, a global daily cap, and
// (when configured) a Cloudflare Turnstile human check.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as btc from '@scure/btc-signer';
import { prepareAndSend, statusFor, walletAddress } from '../src/send.js';
import { getUTXOs } from '../src/esplora.js';
import { net } from '../src/networks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const secret = (f) => JSON.parse(readFileSync(join(HERE, '..', '.secrets', f), 'utf8'));
const MNEMONIC = secret('faucet.json').mnemonic;
// Shared secret for trusted local callers (the Nostr bot). A trusted caller skips
// the per-IP throttle (it IS one IP) but STILL faces per-address + global caps,
// and enforces its own per-account limit. Absent file -> no internal path.
const INTERNAL_TOKEN = existsSync(join(HERE, '..', '.secrets', 'internal.json')) ? secret('internal.json').faucetInternalToken : '';
const PORT = 8790;
const DRIP = 100_000;                       // 0.001 tBTC per claim (~249k grants at current pot; 500/day cap is the real guard)
const NETWORKS = new Set(['testnet3', 'testnet4', 'signet']);
const ALLOW_ORIGIN = new Set(['https://faucet.olesia.io', 'https://olesia.io', 'https://app.olesia.io']);
// Turnstile secret from a 600 file (preferred) or env. Absent -> human check off.
const TURNSTILE_SECRET = (existsSync(join(HERE, '..', '.secrets', 'turnstile.json')) ? secret('turnstile.json').secret : '') || process.env.TURNSTILE_SECRET || '';
const MAX_BODY = 4000;

// ---- faucet coin selection -------------------------------------------------
// The generic sender optimizes for fewest-inputs, which means it always grabs the
// single biggest coin — including an UNCONFIRMED top-up, and leaving the whole
// pot's change dangling in one long unconfirmed chain. For a faucet that is wrong:
// we want to (1) spend only CONFIRMED coins whenever possible, and (2) draw from
// the bank of small pre-split coins, picked at RANDOM so simultaneous claims land
// on different coins instead of colliding on one. Returns a curated UTXO set to
// hand to prepareAndSend({ utxos }), or null to fall back to the default path.
const FEE_HEADROOM = 2000;                 // sat; covers a 2-in/2-out p2wpkh tx at feeRate 2 with margin
const SMALL_COIN_MAX = DRIP * 20;          // treat coins < 0.02 tBTC as "bank" coins; never auto-grab the giant pot coin
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function pickFaucetCoins(network) {
  const addr = walletAddress(MNEMONIC, network, 'p2wpkh');
  const confirmed = (await getUTXOs(addr, network)).filter((u) => u.confirmed);
  if (!confirmed.length) return null;      // nothing confirmed -> caller falls back to allowUnconfirmed
  const need = DRIP + FEE_HEADROOM;
  const bank = confirmed.filter((u) => u.value <= SMALL_COIN_MAX);
  // 1) prefer ONE drip-sized bank coin (keeps every drip a clean 1-in/2-out tx and,
  //    picked at random, spreads concurrent claims across the bank).
  const singles = shuffle(bank.filter((u) => u.value >= need));
  if (singles.length) return [singles[0]];
  // 2) otherwise accumulate random small coins until they cover the drip + fee.
  const acc = []; let sum = 0;
  for (const u of shuffle(bank)) { acc.push(u); sum += u.value; if (sum >= need) return acc; }
  // 3) last resort: smallest single CONFIRMED coin that covers it (may be a large
  //    pot coin, but still confirmed — never an unconfirmed spend).
  const big = confirmed.filter((u) => u.value >= need).sort((a, b) => a.value - b.value)[0];
  return big ? [big] : null;               // 4) nothing confirmed covers it -> caller falls back
}

// rate limits (sliding window)
const RL = { ip: { max: 3, win: 3_600_000 }, addr: { max: 1, win: 86_400_000 }, global: { max: 500, win: 86_400_000 } };
const hits = { ip: new Map(), addr: new Map(), global: [] };
function limited(bucket, key, now) {
  const lim = RL[bucket];
  if (bucket === 'global') { hits.global = hits.global.filter((t) => now - t < lim.win); if (hits.global.length >= lim.max) return true; hits.global.push(now); return false; }
  const m = hits[bucket]; const arr = (m.get(key) || []).filter((t) => now - t < lim.win);
  if (arr.length >= lim.max) { m.set(key, arr); return true; }
  arr.push(now); m.set(key, arr); return false;
}
setInterval(() => { const now = Date.now();
  for (const b of ['ip', 'addr']) for (const [k, a] of hits[b]) { const keep = a.filter((t) => now - t < RL[b].win); keep.length ? hits[b].set(k, keep) : hits[b].delete(k); }
}, 300_000).unref();

const clientIp = (req) => (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown');
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(obj)); };

async function turnstileOk(token, ip) {
  if (!TURNSTILE_SECRET) return true; // not configured yet -> rely on rate limits
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    return !!(await r.json()).success;
  } catch { return false; }
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOW_ORIGIN.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const path = new URL(req.url, 'http://x').pathname;

  if (req.method === 'GET' && path === '/info') {
    Promise.all([...NETWORKS].map((n) => statusFor(MNEMONIC, n, 'p2wpkh').then((s) => [n, s.balance.confirmed]).catch(() => [n, null])))
      .then((bals) => json(res, 200, { drip: DRIP, networks: [...NETWORKS], balances: Object.fromEntries(bals) }))
      .catch((e) => json(res, 502, { error: e.message }));
    return;
  }

  if (req.method === 'POST' && path === '/claim') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', async () => {
      let o; try { o = JSON.parse(body); } catch { return json(res, 400, { error: 'bad request' }); }
      const network = String(o.network || '');
      const address = String(o.address || '').trim();
      if (!NETWORKS.has(network)) return json(res, 400, { error: 'network must be testnet3 or testnet4' });
      try { btc.Address(net(network).btc).decode(address); } catch { return json(res, 400, { error: 'invalid testnet address' }); }
      const internal = INTERNAL_TOKEN && req.headers['x-faucet-internal'] === INTERNAL_TOKEN;
      if (!internal && !(await turnstileOk(o.token, clientIp(req)))) return json(res, 403, { error: 'human check failed' });
      const now = Date.now();
      if (limited('global', '', now)) return json(res, 429, { error: 'faucet daily cap reached — try tomorrow' });
      if (!internal && limited('ip', clientIp(req), now)) return json(res, 429, { error: 'rate limit — one claim per IP per hour (max 3)' });
      if (limited('addr', address, now)) return json(res, 429, { error: 'this address already got coins today' });
      try {
        const opts = { source: MNEMONIC, network, scriptType: 'p2wpkh', recipients: [{ address, amount: DRIP }], feeRate: 2, broadcast: true };
        const coins = await pickFaucetCoins(network).catch(() => null);
        // Confirmed bank coins if we have them; only chain off unconfirmed as a last resort.
        if (coins && coins.length) opts.utxos = coins; else opts.allowUnconfirmed = true;
        const r = await prepareAndSend(opts);
        json(res, 200, { txid: r.broadcastTxid, amount: DRIP, explorer: r.explorer });
      } catch (e) { json(res, 400, { error: String(e.message).slice(0, 200) }); }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
});
server.listen(PORT, '127.0.0.1', () => console.log(`olesia faucet on 127.0.0.1:${PORT}`));
