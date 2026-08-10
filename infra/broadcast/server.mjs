// Olesia broadcast service — the backend behind api.olesia.io.
// A tiny, dependency-free HTTP service that lets the wallet broadcast a raw tx
// through YOUR OWN Bitcoin node (mainnet) instead of a public API. It holds NO
// keys and touches NO wallet (the node runs disablewallet=1). It only relays
// transactions and reports public node status — the same surface a public
// esplora broadcast endpoint exposes.
//
// Binds to localhost; a Cloudflare Tunnel maps https://api.olesia.io -> here.
import http from 'node:http';
import { execFile } from 'node:child_process';

const PORT = 8787;
const DATADIR = '/var/lib/bitcoind';
const ALLOW_ORIGIN = new Set(['https://app.olesia.io', 'https://olesia.io']);
const MAX_BODY = 400_000; // ~200 KB raw tx cap

function bcli(args) {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['-u', 'bitcoin', '/usr/local/bin/bitcoin-cli', `-datadir=${DATADIR}`, ...args],
      { timeout: 15000, maxBuffer: 2e6 },
      (e, out, err) => e ? reject(new Error(String(err || e.message).trim())) : resolve(out.toString().trim()));
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOW_ORIGIN.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const path = new URL(req.url, 'http://x').pathname;

  if (req.method === 'GET' && path === '/status') {
    bcli(['getblockchaininfo'])
      .then((o) => { const i = JSON.parse(o); json(res, 200, { chain: i.chain, blocks: i.blocks, headers: i.headers, ibd: i.initialblockdownload, verificationprogress: i.verificationprogress, pruned: i.pruned }); })
      .catch((e) => json(res, 502, { error: e.message }));
    return;
  }

  if (req.method === 'POST' && path === '/broadcast') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', async () => {
      let hex; try { const j = JSON.parse(body); hex = String(j.txHex || j.tx || '').trim(); } catch { hex = body.trim(); }
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) return json(res, 400, { error: 'invalid raw transaction hex' });
      try {
        const test = JSON.parse(await bcli(['testmempoolaccept', JSON.stringify([hex])]));
        if (!test[0]?.allowed) return json(res, 400, { error: 'rejected: ' + (test[0]['reject-reason'] || 'not accepted by node') });
        const txid = await bcli(['sendrawtransaction', hex]);
        json(res, 200, { txid });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});
server.listen(PORT, '127.0.0.1', () => console.log(`olesia broadcast service on 127.0.0.1:${PORT}`));
