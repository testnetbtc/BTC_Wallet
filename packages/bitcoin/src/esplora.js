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

export async function getUTXOs(address, networkName) {
  const base = net(networkName).esplora;
  const utxos = JSON.parse(await j(`${base}/address/${address}/utxo`));
  // [{ txid, vout, value, status:{confirmed, block_height,...} }]
  return utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
}

export async function getBalance(address, networkName) {
  const base = net(networkName).esplora;
  const info = JSON.parse(await j(`${base}/address/${address}`));
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
  const base = net(networkName).esplora;
  return (await j(`${base}/tx`, { method: 'POST', body: txHex })).trim(); // returns txid
}
