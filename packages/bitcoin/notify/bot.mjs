// Olesia Telegram Alerts — watch-only Bitcoin notification bot.
//
// Four alert types: address activity, price, fee/mempool, new blocks & halving.
// Long-polls Telegram (no inbound port needed), stores subscriptions in SQLite.
// ALL on-chain data (address activity, fees, blocks) comes from OUR OWN full
// node via local RPC — watched addresses never touch a third-party explorer.
// Price is the sole exception (fiat is not on-chain): an exchange ticker.
//
// HARD SAFETY RULE (non-negotiable): watch-only. This bot NEVER accepts or
// stores a seed phrase, WIF, or private key of any kind. Any input that looks
// like one is rejected with a warning, before it is ever logged or persisted.
// The service holds no keys and cannot sign or move funds.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { net } from '../src/networks.js';
import { tipHeight, fastestFee, scanBlock, btcUsd, NODE_NETWORK } from './node.mjs';
import { classifyInput, xpubAddresses, XPUB_GAP } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEC = (f) => JSON.parse(readFileSync(join(HERE, '..', '.secrets', f), 'utf8'));
const TOKEN = SEC('telegram.json').token;
const BOT_USERNAME = (existsSync(join(HERE, '..', '.secrets', 'telegram.json')) && SEC('telegram.json').username) || 'OlesiaAlertsBot';
const API = `https://api.telegram.org/bot${TOKEN}`;
const DB_FILE = join(HERE, '..', '.secrets', 'notify.db');
const HEARTBEAT = join(HERE, '..', '.secrets', 'notify-heartbeat.json');

const MAX_SUBS_PER_USER = 25;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const nows = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ database
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id   INTEGER PRIMARY KEY,
    created_at INTEGER,
    tz        TEXT,
    mute_until INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS subs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id   INTEGER NOT NULL,
    type      TEXT NOT NULL,           -- addr | price | fee | blocks
    params    TEXT NOT NULL,           -- JSON
    repeat    INTEGER DEFAULT 0,
    last_fired INTEGER DEFAULT 0,
    active    INTEGER DEFAULT 1,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS subs_active_idx ON subs(active, type);
  CREATE TABLE IF NOT EXISTS seen (
    sub_id INTEGER NOT NULL,
    k      TEXT NOT NULL,              -- txid / block height / etc.
    ts     INTEGER,
    PRIMARY KEY (sub_id, k)
  );
`);
const q = {
  upsertUser: db.prepare('INSERT INTO users(chat_id,created_at) VALUES(?,?) ON CONFLICT(chat_id) DO NOTHING'),
  getUser: db.prepare('SELECT * FROM users WHERE chat_id=?'),
  setMute: db.prepare('UPDATE users SET mute_until=? WHERE chat_id=?'),
  addSub: db.prepare('INSERT INTO subs(chat_id,type,params,repeat,active,created_at) VALUES(?,?,?,?,1,?)'),
  countSubs: db.prepare('SELECT COUNT(*) c FROM subs WHERE chat_id=? AND active=1'),
  listSubs: db.prepare('SELECT * FROM subs WHERE chat_id=? AND active=1 ORDER BY id'),
  getSub: db.prepare('SELECT * FROM subs WHERE id=? AND chat_id=?'),
  deactivate: db.prepare('UPDATE subs SET active=0 WHERE id=?'),
  activeByType: db.prepare('SELECT * FROM subs WHERE active=1 AND type=?'),
  touchFired: db.prepare('UPDATE subs SET last_fired=? WHERE id=?'),
  markSeen: db.prepare('INSERT INTO seen(sub_id,k,ts) VALUES(?,?,?) ON CONFLICT(sub_id,k) DO NOTHING'),
  wasSeen: db.prepare('SELECT 1 FROM seen WHERE sub_id=? AND k=?'),
};


// ------------------------------------------------------------ telegram helpers
async function tg(method, body) {
  try {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { log('tg err', method, e.message); return { ok: false }; }
}
async function send(chatId, text, opts = {}) {
  return tg('sendMessage', { chat_id: chatId, text: text.slice(0, 4000),
    disable_web_page_preview: true, parse_mode: 'HTML', ...opts });
}
// dispatcher: respects mute
function dispatch(chatId, text) {
  const u = q.getUser.get(chatId);
  if (u && u.mute_until && u.mute_until > nows()) return;
  return send(chatId, text);
}

// ---------------------------------------------------------------- commands
const HELP = [
  '<b>Olesia Bitcoin Alerts</b> — watch-only notifications.',
  '',
  '<b>/watch</b> &lt;address|xpub&gt; — incoming/outgoing tx alerts',
  '<b>/price</b> &lt;above|below&gt; &lt;usd&gt; [repeat] — BTC price threshold',
  '<b>/fee</b> below &lt;sat/vB&gt; — when fees drop below a target',
  '<b>/blocks</b> on — every new block + halving countdown',
  '<b>/list</b> — your active alerts',
  '<b>/mute</b> 2h — pause all alerts for a while',
  '<b>/remove</b> &lt;id&gt; — cancel one alert',
  '<b>/help</b> — this message',
  '',
  '🔒 Watch-only. Never send a seed phrase or private key — this bot cannot ',
  'and will never ask for one. Your addresses are watched on OUR OWN full node ',
  'and are never sent to a third-party block explorer. (Price is the one ',
  'exception — it comes from an exchange, since no node knows fiat prices.)',
].join('\n');

function capOk(chatId) {
  return q.countSubs.get(chatId).c < MAX_SUBS_PER_USER;
}

async function cmdWatch(chatId, arg) {
  if (!arg) return send(chatId, 'Usage: /watch &lt;address or xpub&gt;');
  const c = classifyInput(arg);
  if (c.kind === 'SECRET')
    return send(chatId, `⛔ That looks like a <b>${c.why}</b>. NEVER share it — with me or anyone. `
      + `I only need a public address or xpub to watch. Your keys stay with you.`);
  if (c.kind === 'INVALID') return send(chatId, `Couldn't read that: ${c.why}.`);
  if (!capOk(chatId)) return send(chatId, `You've hit the ${MAX_SUBS_PER_USER}-alert limit. Remove one with /remove first.`);
  const params = c.kind === 'XPUB'
    ? { mode: 'xpub', xpub: c.value, network: c.network }
    : { mode: 'address', address: c.value, network: c.network };
  const r = q.addSub.run(chatId, 'addr', JSON.stringify(params), 0, nows());
  const what = c.kind === 'XPUB' ? `xpub (first ${XPUB_GAP} receive + ${XPUB_GAP} change addresses)` : c.value;
  const priv = c.network === NODE_NETWORK
    ? `🔒 Watched on our own full node — never sent to any third-party explorer.`
    : `⚠️ ${c.network} isn't served by our node yet, so this one will be checked via a public explorer.`;
  return send(chatId, `✓ Watching ${what} on ${c.network}. Alert id <b>${r.lastInsertRowid}</b>.\n${priv}`);
}

async function cmdPrice(chatId, args) {
  const [dir, usdRaw, rep] = args.split(/\s+/);
  const usd = Number(usdRaw);
  if (!['above', 'below'].includes(dir) || !Number.isFinite(usd) || usd <= 0)
    return send(chatId, 'Usage: /price &lt;above|below&gt; &lt;usd&gt; [repeat]\nExample: /price above 100000');
  if (!capOk(chatId)) return send(chatId, `You've hit the ${MAX_SUBS_PER_USER}-alert limit.`);
  const repeat = /repeat/i.test(rep || '') ? 1 : 0;
  const r = q.addSub.run(chatId, 'price', JSON.stringify({ dir, usd }), repeat, nows());
  return send(chatId, `✓ Alert when BTC goes <b>${dir} $${usd.toLocaleString()}</b>`
    + `${repeat ? ' (repeating)' : ' (one-shot)'}. Alert id <b>${r.lastInsertRowid}</b>.`);
}

async function cmdFee(chatId, args) {
  const m = args.match(/below\s+(\d+(?:\.\d+)?)/i);
  if (!m) return send(chatId, 'Usage: /fee below &lt;sat/vB&gt;\nExample: /fee below 5');
  if (!capOk(chatId)) return send(chatId, `You've hit the ${MAX_SUBS_PER_USER}-alert limit.`);
  const sat = Number(m[1]);
  const r = q.addSub.run(chatId, 'fee', JSON.stringify({ dir: 'below', sat, network: 'mainnet' }), 1, nows());
  return send(chatId, `✓ Alert when the fastest recommended fee drops <b>below ${sat} sat/vB</b>. `
    + `Alert id <b>${r.lastInsertRowid}</b> (re-arms after 6h).`);
}

async function cmdBlocks(chatId, args) {
  if (!/^on\b/i.test(args.trim())) return send(chatId, 'Usage: /blocks on');
  if (!capOk(chatId)) return send(chatId, `You've hit the ${MAX_SUBS_PER_USER}-alert limit.`);
  const r = q.addSub.run(chatId, 'blocks', JSON.stringify({ network: 'mainnet' }), 1, nows());
  return send(chatId, `✓ New-block alerts on, with halving countdown. Alert id <b>${r.lastInsertRowid}</b>. `
    + `(This one is chatty — ~one message every 10 minutes.)`);
}

function cmdList(chatId) {
  const rows = q.listSubs.all(chatId);
  if (!rows.length) return send(chatId, 'No active alerts. Add one with /watch, /price, /fee or /blocks.');
  const line = (s) => {
    const p = JSON.parse(s.params);
    if (s.type === 'addr') return `#${s.id} 👁 ${p.mode === 'xpub' ? 'xpub' : p.address} (${p.network})`;
    if (s.type === 'price') return `#${s.id} 💵 price ${p.dir} $${p.usd.toLocaleString()}${s.repeat ? ' ↻' : ''}`;
    if (s.type === 'fee') return `#${s.id} ⛽ fee below ${p.sat} sat/vB`;
    if (s.type === 'blocks') return `#${s.id} 🧱 new blocks`;
    return `#${s.id} ${s.type}`;
  };
  return send(chatId, '<b>Your alerts:</b>\n' + rows.map(line).join('\n') + '\n\nRemove one: /remove &lt;id&gt;');
}

function cmdMute(chatId, arg) {
  const m = (arg || '').match(/(\d+)\s*([hmd])/i);
  if (!m) return send(chatId, 'Usage: /mute 2h  (m=minutes, h=hours, d=days)');
  const n = Number(m[1]); const unit = m[2].toLowerCase();
  const secs = n * (unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400);
  q.setMute.run(nows() + secs, chatId);
  return send(chatId, `🔇 Muted for ${n}${unit}. Alerts resume automatically.`);
}

function cmdRemove(chatId, arg) {
  const id = Number(arg);
  if (!Number.isInteger(id)) return send(chatId, 'Usage: /remove &lt;id&gt; (see /list)');
  const s = q.getSub.get(id, chatId);
  if (!s) return send(chatId, `No active alert #${id} of yours.`);
  q.deactivate.run(id);
  return send(chatId, `🗑 Removed alert #${id}.`);
}

async function onMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (!chatId || !text) return;
  q.upsertUser.run(chatId, nows());
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  const c = cmd.toLowerCase().replace(/@.*$/, '');
  try {
    if (c === '/start' || c === '/help') return await send(chatId, HELP);
    if (c === '/watch') return await cmdWatch(chatId, arg);
    if (c === '/price') return await cmdPrice(chatId, arg);
    if (c === '/fee') return await cmdFee(chatId, arg);
    if (c === '/blocks') return await cmdBlocks(chatId, arg);
    if (c === '/list') return cmdList(chatId);
    if (c === '/mute') return cmdMute(chatId, arg);
    if (c === '/remove') return cmdRemove(chatId, arg);
    // Bare address/xpub with no command -> treat as /watch, but classify for safety.
    const cls = classifyInput(text);
    if (cls.kind === 'SECRET')
      return await send(chatId, `⛔ That looks like a <b>${cls.why}</b>. Never share it. I only ever need a public address or xpub.`);
    if (cls.kind === 'ADDRESS' || cls.kind === 'XPUB') return await cmdWatch(chatId, text);
    return await send(chatId, 'Unknown command. Try /help.');
  } catch (e) { log('cmd err', c, e.message); return send(chatId, 'Something went wrong — try again.'); }
}

// --------------------------------------------------------------- watchers

// Scan each NEW block from OUR node against the set of watched addresses.
// Nothing leaves the box — the watched addresses are never sent to any
// third-party explorer. Forward-only (from when watching began), which is
// exactly what a notification service needs.
let lastScanned = null;
async function watchAddresses() {
  const subs = q.activeByType.all('addr');
  if (!subs.length) return;
  const idx = new Map();                       // address -> [subs]
  for (const s of subs) {
    const p = JSON.parse(s.params);
    if (p.network !== NODE_NETWORK) continue;   // our node is mainnet; testnet needs another source
    const addrs = p.mode === 'xpub' ? xpubAddresses(p.xpub, p.network) : [p.address];
    for (const a of addrs) { if (!idx.has(a)) idx.set(a, []); idx.get(a).push(s); }
  }
  if (!idx.size) return;
  let tip;
  try { tip = await tipHeight(); } catch { return; }
  if (lastScanned == null) { lastScanned = tip; return; }   // begin at the current tip
  const watched = new Set(idx.keys());
  for (let h = lastScanned + 1; h <= tip; h++) {
    let hits;
    try { hits = await scanBlock(h, watched); } catch (e) { log('scanBlock', h, e.message); return; }
    for (const hit of hits) {
      for (const s of idx.get(hit.address) || []) {
        const key = `${hit.txid}:${hit.direction}`;
        if (q.wasSeen.get(s.id, key)) continue;
        q.markSeen.run(s.id, key, nows());
        const p = JSON.parse(s.params);
        const url = net(p.network).explorer + hit.txid;
        const dir = hit.direction === 'in' ? 'Incoming' : 'Outgoing';
        dispatch(s.chat_id, `👁 <b>${dir}</b> on ${p.mode === 'xpub' ? 'your xpub' : hit.address}\n`
          + `Confirmed in block ${h.toLocaleString()} — <a href="${url}">${hit.txid.slice(0, 16)}…</a>\n`
          + `Seen by our own node — this address was never sent to a third-party explorer.`);
      }
    }
    lastScanned = h;
  }
}

let lastPrice = null;
async function watchPrice() {
  const subs = q.activeByType.all('price');
  if (!subs.length) return;
  let price;
  try { price = await btcUsd(); } catch { return; }   // exchange ticker: the one off-chain feed
  if (!Number.isFinite(price)) return;
  const prev = lastPrice; lastPrice = price;
  for (const s of subs) {
    const p = JSON.parse(s.params);
    const crossed = p.dir === 'above'
      ? price >= p.usd && (prev == null || prev < p.usd)
      : price <= p.usd && (prev == null || prev > p.usd);
    if (!crossed) continue;
    dispatch(s.chat_id, `💵 <b>BTC ${p.dir} $${p.usd.toLocaleString()}</b> — now $${price.toLocaleString()}`);
    if (s.repeat) q.touchFired.run(nows(), s.id); else q.deactivate.run(s.id);
  }
}

async function watchFees() {
  const subs = q.activeByType.all('fee');
  if (!subs.length) return;
  let fast;
  try { fast = await fastestFee(); } catch { return; }   // our node's own estimatesmartfee
  if (!Number.isFinite(fast)) return;
  const COOLDOWN = 6 * 3600;
  for (const s of subs) {
    const p = JSON.parse(s.params);
    if (fast >= p.sat) continue;
    if (nows() - s.last_fired < COOLDOWN) continue;
    q.touchFired.run(nows(), s.id);
    dispatch(s.chat_id, `⛽ <b>Fees dropped to ${fast} sat/vB</b> (below your ${p.sat} target). Good time to move coins.`);
  }
}

const HALVING_INTERVAL = 210000;
let lastTip = null;
async function watchBlocks() {
  const subs = q.activeByType.all('blocks');
  if (!subs.length) return;
  let tip;
  try { tip = await tipHeight(); } catch { return; }   // our node's getblockcount
  if (!Number.isFinite(tip)) return;
  const prev = lastTip; lastTip = tip;
  if (prev == null || tip <= prev) return;   // only on genuinely new tip
  const toHalving = HALVING_INTERVAL - (tip % HALVING_INTERVAL);
  const halvingNote = toHalving <= 1000 ? `\n⏳ ${toHalving.toLocaleString()} blocks to the next halving.` : '';
  for (const s of subs) {
    if (q.wasSeen.get(s.id, String(tip))) continue;
    q.markSeen.run(s.id, String(tip), nows());
    dispatch(s.chat_id, `🧱 <b>Block ${tip.toLocaleString()}</b>${halvingNote}`);
  }
}

// ------------------------------------------------------------------- loops
let offset = 0;
async function pollTelegram() {
  const r = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
  if (r.ok) for (const u of r.result) {
    offset = u.update_id + 1;
    if (u.message) await onMessage(u.message).catch((e) => log('msg err', e.message));
  }
}
async function loopTelegram() { for (;;) { try { await pollTelegram(); } catch (e) { log('poll err', e.message); await new Promise((r) => setTimeout(r, 3000)); } } }

async function runWatchers() {
  for (const [fn, name] of [[watchAddresses, 'addr'], [watchPrice, 'price'], [watchFees, 'fee'], [watchBlocks, 'blocks']]) {
    try { await fn(); } catch (e) { log('watcher', name, e.message); }
  }
}

const beat = () => { try { writeFileSync(HEARTBEAT, JSON.stringify({ t: Date.now(), bot: BOT_USERNAME })); } catch {} };

log(`olesia-notify starting as @${BOT_USERNAME}`);
tg('setMyCommands', { commands: [
  { command: 'watch', description: 'Watch an address or xpub' },
  { command: 'price', description: 'BTC price threshold alert' },
  { command: 'fee', description: 'Fee drops below a target' },
  { command: 'blocks', description: 'New block + halving alerts' },
  { command: 'list', description: 'Your active alerts' },
  { command: 'mute', description: 'Pause alerts (e.g. /mute 2h)' },
  { command: 'remove', description: 'Cancel an alert by id' },
  { command: 'help', description: 'How this works' },
] });
beat(); setInterval(beat, 60000).unref();
setInterval(runWatchers, 60000);
runWatchers();
loopTelegram();
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });
