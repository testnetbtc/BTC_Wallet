// Olesia P2PK Explorer — dataset builder + daily forward updater.
//
// P2PK (bare public-key) outputs are invisible to normal explorers because there
// is no address to search by. This tool builds a browsable dataset of them:
//   1) a curated seed of the historically famous P2PK transactions (Satoshi era),
//      fetched by txid from the public API (which DOES return P2PK by txid);
//   2) a forward scan of every NEW block from our own node, appending any P2PK.
// The full genesis->today backfill (BigQuery) lands later; this owns the site now.
//
// Output: landing/p2pk/data/p2pk.json (records) + meta.json (stats). Static files
// served from olesia.io/p2pk and rebuilt daily by cron.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'landing', 'p2pk', 'data');
const API = 'https://mempool.space/api';
const CLI = ['sudo', '-u', 'bitcoin', '/usr/local/bin/bitcoin-cli', '-datadir=/var/lib/bitcoind'];

// ---- curated seed: the P2PK transactions worth opening the museum with ----
const GENESIS = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';
const GENESIS_PUBKEY = '04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f';
const SEED = [
  { txid: GENESIS, label: 'The Genesis Block coinbase — 50 BTC to Satoshi, unspendable by design', pin: true },
  { txid: '0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098', label: 'Block 1 coinbase — the first mined block after genesis' },
  { txid: '9b0fc92260312ce44e74ef369f5c66bbb85848f2eddd5a7a1cde251e54ccfdd5', label: 'Block 2 coinbase' },
  { txid: '0437cd7f8525ceed2324359c2d0ba26006d92d856a9c20fa0241106ee5a597c9', label: 'Block 9 coinbase — the 50 BTC Satoshi later sent to Hal Finney' },
  { txid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16', label: 'The first Bitcoin transaction — Satoshi → Hal Finney (block 170, 12 Jan 2009)', pin: true },
  { txid: 'a16f3ce4dd5deb92d98ef5cf8afeaf0775ebca408f708b2146c4fb42b41e14be', label: 'An early P2PK transaction (block 181)' },
  { txid: 'd5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599', label: 'An early P2PK payment (block 91,812)' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jget(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch { /* retry */ }
    await sleep(600 * (i + 1));
  }
  return null;
}
const cli = (...args) => execFileSync(CLI[0], [...CLI.slice(1), ...args], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

// <push> <pubkey> OP_CHECKSIG(ac) — push is 0x21 (33-byte compressed) or 0x41 (65-byte uncompressed)
function p2pkKey(scriptHex) {
  const s = (scriptHex || '').toLowerCase();
  if (!s.endsWith('ac')) return null;
  const bits = s.startsWith('21') ? 33 : s.startsWith('41') ? 65 : 0;
  if (!bits) return null;
  const pk = s.slice(2, 2 + bits * 2);
  return pk.length === bits * 2 ? { pubkey: pk, bits } : null;
}

// Build one record from a public-API tx (mainnet), incl. spent status per output.
async function recordFromApi(txid, label) {
  const tx = await jget(`${API}/tx/${txid}`);
  if (!tx) return null;
  const spends = (await jget(`${API}/tx/${txid}/outspends`)) || [];
  const outputs = [];
  tx.vout.forEach((o, vout) => {
    if (o.scriptpubkey_type !== 'p2pk') return;
    const k = p2pkKey(o.scriptpubkey);
    outputs.push({ vout, pubkey: k?.pubkey || null, bits: k?.bits || null, value: o.value, spentBy: spends[vout]?.spent ? spends[vout].txid : null });
  });
  if (!outputs.length) return null;
  return {
    txid, network: 'mainnet', label: label || null,
    block: tx.status?.block_height ?? null, time: tx.status?.block_time ?? null,
    coinbase: !!tx.vin?.[0]?.is_coinbase,
    outputs, totalValue: outputs.reduce((a, o) => a + o.value, 0),
  };
}

function genesisRecord(label) {
  return { txid: GENESIS, network: 'mainnet', label, block: 0, time: 1231006505, coinbase: true,
    outputs: [{ vout: 0, pubkey: GENESIS_PUBKEY, bits: 65, value: 5000000000, spentBy: null }], totalValue: 5000000000 };
}

// Forward scan: append P2PK from new blocks our (pruned) node holds, since last tip.
function scanNode(fromHeight, toHeight, seen) {
  const found = [];
  for (let h = fromHeight; h <= toHeight; h++) {
    let blk;
    try { blk = JSON.parse(cli('getblock', cli('getblockhash', String(h)), '2')); } catch { continue; }
    for (const tx of blk.tx) {
      const outs = [];
      tx.vout.forEach((o) => { if (o.scriptPubKey?.type === 'pubkey') { const k = p2pkKey(o.scriptPubKey.hex); outs.push({ vout: o.n, pubkey: k?.pubkey || null, bits: k?.bits || null, value: Math.round(o.value * 1e8), spentBy: null }); } });
      if (outs.length && !seen.has(tx.txid)) found.push({ txid: tx.txid, network: 'mainnet', label: null, block: h, time: blk.time, coinbase: !!tx.vin?.[0]?.coinbase, outputs: outs, totalValue: outs.reduce((a, o) => a + o.value, 0) });
    }
  }
  return found;
}

async function main() {
  mkdirSync(DATA, { recursive: true });
  const dbPath = join(DATA, 'p2pk.json');
  const metaPath = join(DATA, 'meta.json');
  const db = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, 'utf8')) : [];
  const prevMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
  const byId = new Map(db.map((r) => [r.txid, r]));

  // 1) curated seed (idempotent — refreshes labels + spent status)
  for (const s of SEED) {
    const rec = s.txid === GENESIS ? genesisRecord(s.label) : await recordFromApi(s.txid, s.label);
    if (rec) { rec.pinned = !!s.pin; byId.set(rec.txid, { ...byId.get(rec.txid), ...rec }); process.stdout.write(`  seed ${rec.txid.slice(0, 12)}… ${rec.outputs.length} P2PK\n`); }
    else process.stdout.write(`  seed ${s.txid.slice(0, 12)}… (not returned)\n`);
    await sleep(300);
  }

  // 2) forward scan from our node
  let tip = 0; try { tip = Number(cli('getblockcount')); } catch { /* node down */ }
  const info = (() => { try { return JSON.parse(cli('getblockchaininfo')); } catch { return {}; } })();
  const lastScanned = prevMeta.lastScannedHeight;
  const scanFrom = process.argv.includes('--scan-recent')
    ? Math.max(info.pruneheight || 0, tip - Number(process.argv[process.argv.indexOf('--scan-recent') + 1] || 1000))
    : (lastScanned ? lastScanned + 1 : tip); // first run: don't backscan; cron catches new blocks
  if (tip && scanFrom <= tip) {
    process.stdout.write(`  scanning node blocks ${scanFrom}..${tip}\n`);
    for (const rec of scanNode(scanFrom, tip, byId)) byId.set(rec.txid, rec);
  }

  const all = [...byId.values()].sort((a, b) => (b.block ?? 1e12) - (a.block ?? 1e12) || a.txid.localeCompare(b.txid));
  const meta = {
    updatedAt: new Date().toISOString(),
    count: all.length,
    totalOutputs: all.reduce((a, r) => a + r.outputs.length, 0),
    totalValue: all.reduce((a, r) => a + r.totalValue, 0),
    tipHeight: tip || prevMeta.tipHeight || null,
    lastScannedHeight: tip || lastScanned || null,
    backfill: 'in-progress', // full genesis->today import pending (Phase B)
    earliestBlock: all.reduce((m, r) => Math.min(m, r.block ?? 1e12), 1e12),
  };
  writeFileSync(dbPath, JSON.stringify(all));
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  process.stdout.write(`\n  wrote ${all.length} records · ${meta.totalOutputs} P2PK outputs · ${(meta.totalValue / 1e8).toFixed(2)} BTC · tip ${meta.tipHeight}\n`);
}
main().catch((e) => { console.error('build failed:', e.message); process.exit(1); });
