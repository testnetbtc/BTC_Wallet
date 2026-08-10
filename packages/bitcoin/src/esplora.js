// Minimal Esplora (mempool.space / blockstream) client: fetch UTXOs, fee rate,
// balance, and broadcast. No API key needed. This is the network side and is
// deliberately separate from the offline generator (which never touches network).
import { net } from './networks.js';

async function j(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts?.method || 'GET'} ${url} -> ${r.status}: ${text.slice(0, 200)}`);
  return text;
}

// A lookup target is either an address (string) or { scripthash } for scripts with
// no address (P2PK). Esplora serves both under /address/... and /scripthash/...
const locPath = (t) => (typeof t === 'string' ? `/address/${t}` : `/scripthash/${t.scripthash}`);

// Full raw previous transaction (hex) — needed to spend LEGACY inputs (nonWitnessUtxo).
export async function getTxHex(txid, networkName) {
  return (await j(`${net(networkName).esplora}/tx/${txid}/hex`)).trim();
}

// Decoded transaction JSON (used to read a specific P2PK output that explorers
// don't index by address — we track its outpoint ourselves).
export async function getTx(txid, networkName) {
  return JSON.parse(await j(`${net(networkName).esplora}/tx/${txid}`));
}

// Is a specific output spent? -> { spent: bool, txid?, vin?, status? }
export async function getOutspend(txid, vout, networkName) {
  return JSON.parse(await j(`${net(networkName).esplora}/tx/${txid}/outspend/${vout}`));
}

export async function getUTXOs(target, networkName) {
  const base = net(networkName).esplora;
  const utxos = JSON.parse(await j(`${base}${locPath(target)}/utxo`));
  // [{ txid, vout, value, status:{confirmed, block_height,...} }]
  return utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
}

export async function getBalance(target, networkName) {
  const base = net(networkName).esplora;
  const info = JSON.parse(await j(`${base}${locPath(target)}`));
  const c = info.chain_stats, m = info.mempool_stats;
  const confirmed = (c.funded_txo_sum - c.spent_txo_sum);
  const pending = (m.funded_txo_sum - m.spent_txo_sum);
  return { confirmed, pending, total: confirmed + pending };
}

export async function getFeeRate(networkName, target = 6) {
  const base = net(networkName).esplora;
  try {
    const f = JSON.parse(await j(`${base}/fee-estimates`));
    return Math.max(1, Math.ceil(f[String(target)] ?? f['6'] ?? 2));
  } catch { return 2; }
}

export async function broadcast(txHex, networkName) {
  // Mainnet goes through YOUR OWN node (api.olesia.io -> tunnel -> bitcoind), which
  // validates with testmempoolaccept before sendrawtransaction. Testnet stays on the
  // public API (the node is mainnet-only).
  if (networkName === 'mainnet') {
    const r = await fetch('https://api.olesia.io/broadcast', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHex }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`own-node broadcast rejected: ${t.slice(0, 200)}`);
    try { return JSON.parse(t).txid; } catch { return t.trim(); }
  }
  const base = net(networkName).esplora;
  return (await j(`${base}/tx`, { method: 'POST', body: txHex })).trim(); // returns txid
}

// Recent transaction history for an address, with the net effect (sats) on it.
export async function getTxHistory(target, networkName, limit = 15) {
  const base = net(networkName).esplora;
  const addr = typeof target === 'string' ? target : null; // net-per-address only for addressed types
  const txs = JSON.parse(await j(`${base}${locPath(target)}/txs`));
  return txs.slice(0, limit).map((t) => {
    let inFromUs = 0, outToUs = 0;
    if (addr) {
      for (const vin of t.vin) if (vin.prevout?.scriptpubkey_address === addr) inFromUs += vin.prevout.value;
      for (const vout of t.vout) if (vout.scriptpubkey_address === addr) outToUs += vout.value;
    }
    return {
      txid: t.txid,
      confirmed: !!t.status?.confirmed,
      height: t.status?.block_height ?? null,
      net: outToUs - inFromUs, // >0 received, <0 sent
      fee: t.fee ?? 0,
    };
  });
}
