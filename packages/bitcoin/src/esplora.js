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

// Recent transaction history for an address, with the net effect (sats) on it.
export async function getTxHistory(address, networkName, limit = 15) {
  const base = net(networkName).esplora;
  const txs = JSON.parse(await j(`${base}/address/${address}/txs`));
  return txs.slice(0, limit).map((t) => {
    let inFromUs = 0, outToUs = 0;
    for (const vin of t.vin) if (vin.prevout?.scriptpubkey_address === address) inFromUs += vin.prevout.value;
    for (const vout of t.vout) if (vout.scriptpubkey_address === address) outToUs += vout.value;
    return {
      txid: t.txid,
      confirmed: !!t.status?.confirmed,
      height: t.status?.block_height ?? null,
      net: outToUs - inFromUs, // >0 received, <0 sent
      fee: t.fee ?? 0,
    };
  });
}
