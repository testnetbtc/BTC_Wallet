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
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { net } from '../src/networks.js';
import { tipHeight, fastestFee, scanBlock, getBlockHash, btcUsd, NODE_NETWORK, INTAKE } from './node.mjs';
import { ChainTracker } from './chaintracker.mjs';
import { scanAddressesOnce } from './addrwatch.mjs';
import { classifyInput, xpubAddresses, XPUB_GAP } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEC = (f) => JSON.parse(readFileSync(join(HERE, '..', '.secrets', f), 'utf8'));
const TOKEN = SEC('telegram.json').token;
const BOT_USERNAME = (existsSync(join(HERE, '..', '.secrets', 'telegram.json')) && SEC('telegram.json').username) || 'BTCNode_bot';
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
    type      TEXT NOT NULL,           -- addr | price | fee | blocks | feed
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
  -- Public-feed events received from chainwatch detectors (audit + dedup record).
  CREATE TABLE IF NOT EXISTS events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    feed   TEXT NOT NULL,
    k      TEXT NOT NULL,              -- dedup key (usually txid)
    btc    REAL,
    payload TEXT NOT NULL,            -- JSON as received
    ts     INTEGER,
    UNIQUE (feed, k)
  );
  -- RT-10: bounded recent {height: hash} window for reorg detection.
  CREATE TABLE IF NOT EXISTS scan_blocks (
    height INTEGER PRIMARY KEY,
    hash   TEXT NOT NULL
  );
  -- RT-10: address-hit notifications with the block height they came from, so a reorg can
  -- roll back and re-evaluate them. Identity is height-INDEPENDENT (sub_id,txid,direction).
  CREATE TABLE IF NOT EXISTS addr_notified (
    sub_id    INTEGER NOT NULL,
    txid      TEXT NOT NULL,
    direction TEXT NOT NULL,
    height    INTEGER NOT NULL,
    ts        INTEGER,
    PRIMARY KEY (sub_id, txid, direction)
  );
  CREATE INDEX IF NOT EXISTS addr_notified_height_idx ON addr_notified(height);
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
  subsByChatType: db.prepare('SELECT * FROM subs WHERE chat_id=? AND type=? AND active=1'),
  touchFired: db.prepare('UPDATE subs SET last_fired=? WHERE id=?'),
  markSeen: db.prepare('INSERT INTO seen(sub_id,k,ts) VALUES(?,?,?) ON CONFLICT(sub_id,k) DO NOTHING'),
  wasSeen: db.prepare('SELECT 1 FROM seen WHERE sub_id=? AND k=?'),
  recordEvent: db.prepare('INSERT INTO events(feed,k,btc,payload,ts) VALUES(?,?,?,?,?) ON CONFLICT(feed,k) DO NOTHING'),
  // RT-10 reorg tracking
  blkGet: db.prepare('SELECT hash FROM scan_blocks WHERE height=?'),
  blkSet: db.prepare('INSERT INTO scan_blocks(height,hash) VALUES(?,?) ON CONFLICT(height) DO UPDATE SET hash=excluded.hash'),
  blkDel: db.prepare('DELETE FROM scan_blocks WHERE height=?'),
  blkHeights: db.prepare('SELECT height FROM scan_blocks ORDER BY height ASC'),
  anHas: db.prepare('SELECT 1 FROM addr_notified WHERE sub_id=? AND txid=? AND direction=?'),
  anAdd: db.prepare('INSERT INTO addr_notified(sub_id,txid,direction,height,ts) VALUES(?,?,?,?,?) ON CONFLICT(sub_id,txid,direction) DO UPDATE SET height=excluded.height'),
  anDel: db.prepare('DELETE FROM addr_notified WHERE sub_id=? AND txid=? AND direction=?'),
  anByHeights: db.prepare('SELECT sub_id,txid,direction,height FROM addr_notified WHERE height=?'),
};
// RT-10: alert only once a block is buried at least this deep (reorg cushion). A 1-block
// reorg resolves before the user is ever notified. Configurable via notify-node.json.
const NOTIFY_CFG = (() => { try { return SEC('notify-node.json'); } catch { return {}; } })();
const MIN_NOTIFY_CONFIRMATIONS = Number(NOTIFY_CFG.minNotifyConfirmations) > 0 ? Number(NOTIFY_CFG.minNotifyConfirmations) : 2;

// --------------------------------------------------------------- public feeds
// chainwatch's detectors produce these; users opt in per feed. `filter` feeds
// accept a per-user minimum BTC size so people can tune out the noise.
const FEEDS = {
  coldcard: { emoji: '🃏', label: 'Coldcard exploit tracker', filter: false,
    desc: 'Movements from the Jul–Aug 2026 Coldcard exploit wallets.' },
  whales:   { emoji: '🐋', label: 'Whale → exchange moves', filter: true,
    desc: 'Large holders sending to exchange deposit wallets (possible sell pressure).' },
  satoshi:  { emoji: '🛰️', label: 'Satoshi-era coins', filter: false,
    desc: 'Any movement of coins from the earliest blocks / known Satoshi-pattern wallets.' },
  ofac:     { emoji: '⚖️', label: 'OFAC-sanctioned wallets', filter: false,
    desc: 'Movements involving OFAC-SDN listed Bitcoin addresses.' },
};
const subscribedFeeds = (chatId) => {
  const out = new Map();
  for (const s of q.subsByChatType.all(chatId, 'feed')) {
    try { const p = JSON.parse(s.params); out.set(p.feed, { id: s.id, ...p }); } catch { /* skip */ }
  }
  return out;
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
  '<b>/menu</b> — set everything up by tapping (easiest)',
  '<b>/watch</b> &lt;address|xpub&gt; — incoming/outgoing tx alerts',
  '<b>/price</b> &lt;above|below&gt; &lt;usd&gt; [repeat] — BTC price threshold',
  '<b>/fee</b> below &lt;sat/vB&gt; — when fees drop below a target',
  '<b>/blocks</b> on — every new block + halving countdown',
  '<b>/feeds</b> — opt into public intelligence feeds (Coldcard tracker,',
  '   whale→exchange, Satoshi-era, OFAC)',
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
    if (s.type === 'feed') { const f = FEEDS[p.feed]; return `#${s.id} ${f ? f.emoji : '📡'} ${f ? f.label : p.feed}`
      + `${p.min_btc ? ` (≥${p.min_btc}₿)` : ''}`; }
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

// --------------------------------------------------- tap-button menu UX
// Telegram IS the login: every chat_id is an authenticated account. Users
// configure everything by tapping; commands stay for power users.
async function answerCb(id, text) { return tg('answerCallbackQuery', { callback_query_id: id, text: text || '' }); }
async function editMenu(chatId, mid, text, keyboard) {
  return tg('editMessageText', { chat_id: chatId, message_id: mid, text, parse_mode: 'HTML',
    disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
}
async function sendMenu(chatId, text, keyboard) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML',
    disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
}

const MENU_INTRO = [
  '<b>Olesia Bitcoin Alerts</b>',
  'Your own private notifications, straight from our full node.',
  '',
  'Pick what to set up — tap a button, or type /help for commands.',
].join('\n');

function mainKb() {
  return [
    [{ text: '👁 Watch an address', callback_data: 'p:watch' }],
    [{ text: '💵 Price alert', callback_data: 'p:price' }, { text: '⛽ Fee alert', callback_data: 'p:fee' }],
    [{ text: '🧱 New-block alerts', callback_data: 't:blocks' }],
    [{ text: '📡 Public intelligence feeds', callback_data: 'm:feeds' }],
    [{ text: '📋 My alerts', callback_data: 'm:list' }],
  ];
}
function feedsKb(chatId) {
  const subd = subscribedFeeds(chatId);
  const rows = [];
  for (const [key, f] of Object.entries(FEEDS)) {
    const on = subd.has(key);
    rows.push([{ text: `${on ? '✅' : '▫️'} ${f.emoji} ${f.label}`, callback_data: `f:${key}` }]);
    if (on && f.filter) {
      const cur = subd.get(key).min_btc || 0;
      rows.push([50, 100, 250].map((n) => ({
        text: `${cur === n ? '• ' : ''}≥${n}₿`, callback_data: `w:${key}:${n}` })).concat(
        [{ text: `${cur === 0 ? '• ' : ''}all`, callback_data: `w:${key}:0` }]));
    }
  }
  rows.push([{ text: '‹ Back', callback_data: 'm:main' }]);
  return rows;
}
const feedsIntro = () => ['<b>📡 Public intelligence feeds</b>',
  'Opt in to on-chain events our node detects. Tap to toggle.', '',
  ...Object.values(FEEDS).map((f) => `${f.emoji} <b>${f.label}</b> — ${f.desc}`)].join('\n');

// pending free-text capture: after a button asks for a value, the user's next
// message is routed to the matching command. In-memory is fine (a restart just
// means the user taps again).
const pending = new Map();
const PENDING_PROMPT = {
  watch: 'Send me a Bitcoin <b>address</b> or <b>xpub</b> to watch. (Never a seed phrase or private key.)',
  price: 'Send a price target, e.g. <code>above 100000</code> or <code>below 90000</code>.',
  fee:   'Send a fee target in sat/vB, e.g. <code>5</code> — I\'ll alert when fees drop below it.',
};

async function toggleFeed(chatId, key) {
  if (!FEEDS[key]) return;
  const subd = subscribedFeeds(chatId);
  if (subd.has(key)) { q.deactivate.run(subd.get(key).id); return; }
  if (!capOk(chatId)) return send(chatId, `You've hit the ${MAX_SUBS_PER_USER}-alert limit. Remove one with /remove first.`);
  const params = FEEDS[key].filter ? { feed: key, min_btc: 100 } : { feed: key };
  q.addSub.run(chatId, 'feed', JSON.stringify(params), 1, nows());
}
async function setFeedMin(chatId, key, min) {
  const subd = subscribedFeeds(chatId);
  if (!subd.has(key)) return;
  q.deactivate.run(subd.get(key).id);
  q.addSub.run(chatId, 'feed', JSON.stringify({ feed: key, min_btc: min }), 1, nows());
}
async function toggleBlocks(chatId) {
  const rows = q.subsByChatType.all(chatId, 'blocks');
  if (rows.length) { for (const r of rows) q.deactivate.run(r.id); return false; }
  if (!capOk(chatId)) { await send(chatId, `You've hit the ${MAX_SUBS_PER_USER}-alert limit.`); return false; }
  q.addSub.run(chatId, 'blocks', JSON.stringify({ network: 'mainnet' }), 1, nows());
  return true;
}

async function onCallback(cbq) {
  const chatId = cbq.message?.chat?.id;
  const mid = cbq.message?.message_id;
  const data = cbq.data || '';
  if (!chatId) return;
  q.upsertUser.run(chatId, nows());
  try {
    if (data === 'm:main') { await editMenu(chatId, mid, MENU_INTRO, mainKb()); return answerCb(cbq.id); }
    if (data === 'm:feeds') { await editMenu(chatId, mid, feedsIntro(), feedsKb(chatId)); return answerCb(cbq.id); }
    if (data === 'm:list') { await answerCb(cbq.id); return cmdList(chatId); }
    if (data.startsWith('p:')) {
      const kind = data.slice(2);
      pending.set(chatId, kind);
      await answerCb(cbq.id);
      return send(chatId, PENDING_PROMPT[kind] || 'Send the value.');
    }
    if (data === 't:blocks') {
      const on = await toggleBlocks(chatId);
      return answerCb(cbq.id, on ? 'New-block alerts on' : 'New-block alerts off');
    }
    if (data.startsWith('f:')) {
      await toggleFeed(chatId, data.slice(2));
      await editMenu(chatId, mid, feedsIntro(), feedsKb(chatId));
      return answerCb(cbq.id);
    }
    if (data.startsWith('w:')) {
      const [, key, n] = data.split(':');
      await setFeedMin(chatId, key, Number(n));
      await editMenu(chatId, mid, feedsIntro(), feedsKb(chatId));
      return answerCb(cbq.id, Number(n) ? `≥ ${n} BTC` : 'all sizes');
    }
    return answerCb(cbq.id);
  } catch (e) { log('cb err', data, e.message); return answerCb(cbq.id); }
}

// ---------------------------------------------- public-feed intake + delivery
// chainwatch's detectors POST events to 127.0.0.1 and we fan them out to the
// users subscribed to that feed, honouring each user's size filter. Producers
// (detectors) and delivery (this bot) are fully decoupled — that is what makes
// the public feeds multi-tenant instead of one broadcast channel.
// Feed events arrive as structured JSON over the internal intake. Producers are
// trusted (127.0.0.1 + token), but we still escape every field before it becomes
// Telegram HTML and only allow http(s) links — a buggy or compromised detector
// must not be able to inject markup or a javascript: URL into a user's chat.
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const safeHttpUrl = (u) => { try { const x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : null; } catch { return null; } };
function formatEvent(ev) {
  const f = FEEDS[ev.feed];
  const parts = [f ? `${f.emoji} <b>${escHtml(f.label)}</b>` : escHtml(ev.feed)];
  if (ev.title) parts.push(escHtml(ev.title));
  if (ev.body) parts.push(escHtml(ev.body));
  const url = safeHttpUrl(ev.link);
  if (url) parts.push(`<a href="${escHtml(url)}">view transaction</a>`);
  return parts.join('\n');
}
function deliverEvent(ev) {
  if (!FEEDS[ev.feed]) return { ok: false, why: 'unknown feed' };
  const key = String(ev.key || ev.txid || '');
  q.recordEvent.run(ev.feed, key, ev.btc ?? null, JSON.stringify(ev), nows());
  let delivered = 0;
  for (const s of q.activeByType.all('feed')) {
    let p; try { p = JSON.parse(s.params); } catch { continue; }
    if (p.feed !== ev.feed) continue;
    if (p.min_btc && ev.btc != null && Number(ev.btc) < p.min_btc) continue;
    const seenKey = `${ev.feed}:${key}`;
    if (q.wasSeen.get(s.id, seenKey)) continue;
    q.markSeen.run(s.id, seenKey, nows());
    dispatch(s.chat_id, formatEvent(ev));
    delivered++;
  }
  return { ok: true, delivered };
}
function startIntake() {
  if (!INTAKE.token) { log('intake DISABLED (no intakeToken in notify-node.json)'); return; }
  const srv = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); return res.end('ok'); }
    if (req.method !== 'POST' || req.url !== '/event') { res.writeHead(404); return res.end(); }
    if (req.headers['x-intake-token'] !== INTAKE.token) { res.writeHead(401); return res.end('unauthorized'); }
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
    req.on('end', () => {
      let ev; try { ev = JSON.parse(raw); } catch { res.writeHead(400); return res.end('bad json'); }
      try { const r = deliverEvent(ev); res.writeHead(r.ok ? 200 : 422);
        res.end(JSON.stringify(r)); } catch (e) { log('intake err', e.message); res.writeHead(500); res.end('err'); }
    });
  });
  // A port clash (or any listen error) must NOT take down personal alerts:
  // log it and keep the bot running without the feed intake.
  srv.on('error', (e) => log(`intake DISABLED — could not listen on ${INTAKE.port}: ${e.code || e.message}`));
  srv.listen(INTAKE.port, '127.0.0.1', () => log(`intake listening on 127.0.0.1:${INTAKE.port}`));
}

async function onMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (!chatId || !text) return;
  q.upsertUser.run(chatId, nows());

  // A button asked for a value; capture this message as that value.
  if (pending.has(chatId) && !text.startsWith('/')) {
    const kind = pending.get(chatId); pending.delete(chatId);
    if (kind === 'watch') return await cmdWatch(chatId, text);
    if (kind === 'price') return await cmdPrice(chatId, text);
    if (kind === 'fee') return await cmdFee(chatId, /^\s*\d/.test(text) ? `below ${text}` : text);
  }

  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  const c = cmd.toLowerCase().replace(/@.*$/, '');
  try {
    if (c === '/start' || c === '/menu') return await sendMenu(chatId, MENU_INTRO, mainKb());
    if (c === '/help') return await send(chatId, HELP);
    if (c === '/feeds') return await sendMenu(chatId, feedsIntro(), feedsKb(chatId));
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

// Scan each NEW block from OUR node against the set of watched addresses. Nothing leaves the
// box — watched addresses are never sent to any third-party explorer. RT-10: reorg-aware —
// a bounded recent-hash window detects reorgs, rolls back to the fork, rescans the canonical
// branch, and only notifies once a block is >= MIN_NOTIFY_CONFIRMATIONS deep. Notification
// identity is (sub,txid,direction), so a tx reappearing on a new branch never double-notifies;
// a previously-notified tx that is reorged OUT is surfaced as an explicit event.
const trackerStore = {
  get: (h) => { const r = q.blkGet.get(h); return r ? r.hash : undefined; },
  set: (h, hash) => { q.blkSet.run(h, hash); },
  delete: (h) => { q.blkDel.run(h); },
  heights: () => q.blkHeights.all().map((r) => r.height),
};
const notifiedStore = {
  has: (subId, txid, dir) => !!q.anHas.get(subId, txid, dir),
  add: (subId, txid, dir, height) => { q.anAdd.run(subId, txid, dir, height, nows()); },
  remove: (subId, txid, dir) => { q.anDel.run(subId, txid, dir); },
  byHeights: (heights) => heights.flatMap((h) => q.anByHeights.all(h).map((r) => ({ subId: r.sub_id, txid: r.txid, dir: r.direction, height: r.height }))),
};
const tracker = new ChainTracker(trackerStore, { minConf: MIN_NOTIFY_CONFIRMATIONS });

async function watchAddresses() {
  const subs = q.activeByType.all('addr');
  if (!subs.length) return;
  const idx = new Map();                        // address -> [sub]
  for (const s of subs) {
    const p = JSON.parse(s.params);
    if (p.network !== NODE_NETWORK) continue;    // our node is mainnet; testnet needs another source
    const addrs = p.mode === 'xpub' ? xpubAddresses(p.xpub, p.network) : [p.address];
    for (const a of addrs) { if (!idx.has(a)) idx.set(a, []); idx.get(a).push(s); }
  }
  if (!idx.size) return;
  let tip;
  try { tip = await tipHeight(); } catch { return; }
  const watched = new Set(idx.keys());

  const emit = (sub, hit, height) => {
    const p = JSON.parse(sub.params);
    const url = net(p.network).explorer + hit.txid;
    const dir = hit.direction === 'in' ? 'Incoming' : 'Outgoing';
    dispatch(sub.chat_id, `👁 <b>${dir}</b> on ${p.mode === 'xpub' ? 'your xpub' : hit.address}\n`
      + `Confirmed in block ${height.toLocaleString()} (≥${MIN_NOTIFY_CONFIRMATIONS} conf) — <a href="${url}">${hit.txid.slice(0, 16)}…</a>\n`
      + `Seen by our own node — this address was never sent to a third-party explorer.`);
  };
  const emitReorgOut = (o) => {
    const sub = subs.find((s) => s.id === o.subId);
    if (!sub) return;
    const p = JSON.parse(sub.params);
    const url = net(p.network).explorer + o.txid;
    dispatch(sub.chat_id, `♻️ <b>Chain reorg</b> — an earlier alert for <a href="${url}">${o.txid.slice(0, 16)}…</a> `
      + `was rolled back off the canonical chain and has NOT reappeared. Treat that confirmation as reversed.`);
  };

  try {
    await scanAddressesOnce({ tip, getBlockHash, scanBlock, tracker, notified: notifiedStore, watched, idxFor: (a) => idx.get(a) || [], emit, emitReorgOut });
  } catch (e) { log('watchAddresses', e.message); }
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
  const r = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
  if (r.ok) for (const u of r.result) {
    offset = u.update_id + 1;
    if (u.message) await onMessage(u.message).catch((e) => log('msg err', e.message));
    else if (u.callback_query) await onCallback(u.callback_query).catch((e) => log('cb err', e.message));
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
  { command: 'menu', description: 'Open the tap-button menu' },
  { command: 'watch', description: 'Watch an address or xpub' },
  { command: 'price', description: 'BTC price threshold alert' },
  { command: 'fee', description: 'Fee drops below a target' },
  { command: 'blocks', description: 'New block + halving alerts' },
  { command: 'feeds', description: 'Public intelligence feeds' },
  { command: 'list', description: 'Your active alerts' },
  { command: 'mute', description: 'Pause alerts (e.g. /mute 2h)' },
  { command: 'remove', description: 'Cancel an alert by id' },
  { command: 'help', description: 'How this works' },
] });
beat(); setInterval(beat, 60000).unref();
startIntake();
setInterval(runWatchers, 60000);
runWatchers();
loopTelegram();
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });
