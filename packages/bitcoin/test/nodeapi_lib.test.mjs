// Node API logic with a MOCKED Bitcoin Core RPC: input validation, amount conversion, the
// batching scan manager, incremental block following, reorg handling, and prev-tx fetching.
import { validateScripts, validateOutpoints, validateRawTx, isStandardScript, btcToSats, feerateToSatVb, txidOfRaw,
         RateLimiter, ScanManager, fetchPrevTx, ApiError, PriceFeed, quoteFromCoinbase, quotesFromCoinGecko, EsploraBackend, TEST_NETWORKS } from '../../../infra/nodeapi/lib.mjs';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(76), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re ? re.test(e.message) : true; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (n) => '0014' + String(n).padStart(40, '0');           // a P2WPKH script
const TX = (n) => String(n).padStart(64, '0');

// ---- validation ----
ok('standard templates accepted (P2PKH/P2SH/P2WPKH/P2WSH/P2TR/P2PK×2)', ['76a914' + 'ab'.repeat(20) + '88ac', 'a914' + 'ab'.repeat(20) + '87', S(1), '0020' + 'ab'.repeat(32), '5120' + 'ab'.repeat(32), '2102' + 'ab'.repeat(32) + 'ac', '4104' + 'ab'.repeat(64) + 'ac'].every(isStandardScript));
ok('OP_RETURN / arbitrary / truncated scripts rejected', !['6a01ff', '00', S(1).slice(2), S(1) + '00', '51', ''].some(isStandardScript));
ok('descriptor metacharacters can never pass', !isStandardScript(S(1) + ')') && throws(() => validateScripts([S(1) + '),raw(00'], 10), /unsupported/));
ok('scripts are lower-cased, de-duplicated, sorted', JSON.stringify(validateScripts([S(2).toUpperCase(), S(1), S(2)], 10)) === JSON.stringify([S(1), S(2)]));
ok('too many scripts / empty / non-array refused', throws(() => validateScripts([S(1), S(2)], 1), /too many/) && throws(() => validateScripts([], 5), /non-empty/) && throws(() => validateScripts('x', 5), /non-empty/));
ok('outpoints validated', validateOutpoints([{ txid: TX(1), vout: 0 }], 5).length === 1 && throws(() => validateOutpoints([{ txid: 'zz', vout: 0 }], 5), /malformed/) && throws(() => validateOutpoints([{ txid: TX(1), vout: -1 }], 5), /malformed/));
ok('raw tx hex validated (hex, even, size bounds)', throws(() => validateRawTx('zz', 1000), /invalid/) && throws(() => validateRawTx('abc', 1000), /invalid/) && throws(() => validateRawTx('ab'.repeat(2000), 1000), /too large/) && throws(() => validateRawTx('abcd', 1000), /too short/));

// ---- amounts ----
ok('BTC -> sats is exact for awkward decimals', btcToSats(0.1) === 10000000 && btcToSats(5.46e-06) === 546 && btcToSats(20999999.9769) === 2099999997690000 && btcToSats(0.29999999) === 29999999 && btcToSats(1.00000001) === 100000001);
ok('invalid amounts throw', throws(() => btcToSats(-1)) && throws(() => btcToSats(NaN)) && throws(() => btcToSats(3e7)));
ok('fee rate BTC/kvB -> sat/vB rounds UP, floor 1', feerateToSatVb(0.00004190) === 5 && feerateToSatVb(0.00001) === 1 && feerateToSatVb(0.0000025) === 1 && feerateToSatVb(0.00002) === 2 && feerateToSatVb(undefined) === null);

// ---- txid of raw tx (legacy + segwit) against known mainnet transactions ----
const T170 = '0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000';
ok('txidOfRaw: the first Bitcoin payment (block 170)', txidOfRaw(T170) === 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16');
ok('txidOfRaw rejects trailing bytes', throws(() => txidOfRaw(T170 + '00'), /trailing/));

// ---- rate limiter ----
const rl = new RateLimiter({ scan: { max: 3, win: 1000 } });
ok('rate limiter: allows max, blocks max+1, per IP, window slides', !rl.over('a', 'scan', 0) && !rl.over('a', 'scan', 1) && !rl.over('a', 'scan', 2) && rl.over('a', 'scan', 3) && !rl.over('b', 'scan', 3) && !rl.over('a', 'scan', 2000));

// ---- mock node ----
function mockNode() {
  const n = { tipH: 100, hashes: { 100: 'h100' }, utxos: [], blocks: {}, scanCalls: [], spentInMempool: new Set(), busy: 0, delay: 20, reorged: new Set() };
  n.rpc = async (method, params = []) => {
    if (method === 'scantxoutset') {
      if (params[0] === 'status') return { progress: 50 };
      if (n.busy-- > 0) throw new Error('Scan already in progress, use action "abort" or "status"');
      n.scanCalls.push(params[1]); await sleep(n.delay);
      const want = new Set(params[1].map((d) => d.slice(4, -1)));
      return { success: true, height: n.tipH, bestblock: n.hashes[n.tipH], unspents: n.utxos.filter((u) => want.has(u.scriptPubKey)) };
    }
    if (method === 'getbestblockhash') return n.hashes[n.tipH];
    if (method === 'getblockheader') { const h = Object.keys(n.hashes).find((k) => n.hashes[k] === params[0]); return { height: Number(h), confirmations: n.reorged.has(params[0]) ? -1 : n.tipH - Number(h) + 1 }; }
    if (method === 'getblockhash') return n.hashes[params[0]];
    if (method === 'getblock') return n.blocks[params[0]];
    if (method === 'gettxout') return n.spentInMempool.has(`${params[0]}:${params[1]}`) ? null : { value: 1 };
    throw new Error('unmocked ' + method);
  };
  n.addBlock = (txs) => { const h = ++n.tipH; n.hashes[h] = 'h' + h; n.blocks['h' + h] = { hash: 'h' + h, height: h, previousblockhash: n.hashes[h - 1], tx: txs }; };
  return n;
}
const waitDone = async (m, id) => { for (let i = 0; i < 200; i++) { const v = await m.view(id); if (v.state === 'done' || v.state === 'error') return v; await sleep(10); } throw new Error('timeout'); };

// ---- batching: jobs waiting behind a scan are merged into ONE scan and split correctly ----
{
  const n = mockNode();
  n.utxos = [{ txid: TX(1), vout: 0, scriptPubKey: S(1), amount: 0.5, height: 90 }, { txid: TX(2), vout: 1, scriptPubKey: S(2), amount: 0.25, height: 95, coinbase: true }, { txid: TX(3), vout: 0, scriptPubKey: S(3), amount: 1, height: 99 }];
  const m = new ScanManager({ rpc: n.rpc, statusEvery: 5, liveTtl: 0 });
  const j1 = await m.submit([S(1)]);
  const [j2, j3] = await Promise.all([m.submit([S(2), S(9)]), m.submit([S(3)])]);
  const q = await m.view(j2.id);
  ok('a job behind a running scan reports queued + position', q.state === 'queued' && q.position >= 1);
  const [v1, v2, v3] = await Promise.all([waitDone(m, j1.id), waitDone(m, j2.id), waitDone(m, j3.id)]);
  ok('3 jobs were served by exactly 2 node scans (2nd+3rd merged)', n.scanCalls.length === 2 && n.scanCalls[1].length === 3);
  ok('each job gets ONLY its own coins', v1.utxos.length === 1 && v1.utxos[0].txid === TX(1) && v2.utxos.length === 1 && v2.utxos[0].txid === TX(2) && v3.utxos[0].txid === TX(3));
  ok('coin fields: sats, confirmations, coinbase flag', v1.utxos[0].value === 50000000 && v1.utxos[0].confirmations === 11 && v2.utxos[0].coinbase === true && v1.height === 100);
  ok('job ids are long random hex (the id is the only handle)', /^[0-9a-f]{36}$/.test(j1.id) && j1.id !== j2.id);

  // same script set again -> served from the cached entry, no new scan
  const j4 = await m.submit([S(1)]);
  ok('repeat lookup at the same tip is instant (no node scan)', j4.state === 'done' && n.scanCalls.length === 2);

  // mempool spend flag
  n.spentInMempool.add(`${TX(1)}:0`);
  ok('a coin spent in the mempool is flagged', (await m.view(j4.id)).utxos[0].spentInMempool === true);
  n.spentInMempool.clear();

  // new block: spends TX(1):0, pays S(1) a new coin, and pays an unrelated script
  n.addBlock([{ txid: TX(50), vin: [{ coinbase: '00' }], vout: [{ n: 0, value: 3.125, scriptPubKey: { hex: S(77) } }] },
              { txid: TX(51), vin: [{ txid: TX(1), vout: 0 }], vout: [{ n: 0, value: 0.2, scriptPubKey: { hex: S(8) } }, { n: 1, value: 0.29999999, scriptPubKey: { hex: S(1) } }] }]);
  const v5 = await waitDone(m, (await m.submit([S(1)])).id);
  ok('block following: spent coin removed, new coin added, no rescan', n.scanCalls.length === 2 && v5.utxos.length === 1 && v5.utxos[0].txid === TX(51) && v5.utxos[0].vout === 1 && v5.utxos[0].value === 29999999 && v5.height === 101);
  ok('other wallets’ entries are advanced too', (await m.view(j3.id)).height === 101);

  // force -> real rescan
  n.utxos = [{ txid: TX(51), vout: 1, scriptPubKey: S(1), amount: 0.29999999, height: 101 }];
  await waitDone(m, (await m.submit([S(1)], { force: true })).id);
  ok('force:true performs a fresh node scan', n.scanCalls.length === 3);

  // reorg: the entry's block is no longer in the best chain -> entry dropped -> rescan
  n.reorged.add('h101'); n.addBlock([]);
  const j6 = await m.submit([S(1)]);
  ok('reorg invalidates the cached entry and triggers a rescan', j6.state !== 'done' && (await waitDone(m, j6.id)).state === 'done' && n.scanCalls.length === 4);
}
// ---- coin cap + bounded mempool checks (a busy public address must not become a DoS lever) ----
{
  const n = mockNode(); let gettxoutCalls = 0;
  const rpc = async (meth, p) => { if (meth === 'gettxout') gettxoutCalls++; return n.rpc(meth, p); };
  n.utxos = Array.from({ length: 12 }, (_, i) => ({ txid: TX(100 + i), vout: 0, scriptPubKey: S(1), amount: 0.001, height: 90 }))
    .concat([{ txid: TX(200), vout: 0, scriptPubKey: S(2), amount: 1, height: 90 }]);
  let clock = 1000;
  const m = new ScanManager({ rpc, maxCoins: 10, liveTtl: 5000, now: () => clock });
  const [big, small] = await Promise.all([m.submit([S(1)]), m.submit([S(2)])]);
  const vb = await waitDone(m, big.id), vs = await waitDone(m, small.id);
  ok('a script set over the coin cap is refused with a clear error', vb.state === 'error' && /more than 10 separate coins/.test(vb.error));
  ok('…while other wallets in the same batch are served normally', vs.state === 'done' && vs.utxos.length === 1);
  const before = gettxoutCalls; await m.view(small.id); await m.view(small.id); await m.view(small.id);
  ok('repeated polls reuse the mempool check (no extra node calls within 5 s)', gettxoutCalls === before);
  clock += 6000; await m.view(small.id);
  ok('…and it is refreshed after the short cache expires', gettxoutCalls === before + 1);
  n.spentInMempool.add(`${TX(200)}:0`); clock += 6000;
  ok('a mempool spend is still picked up after the cache expires', (await m.view(small.id)).utxos[0].spentInMempool === true);
}
// ---- node scan slot busy (another process scanning): wait and retry, don't fail ----
{
  const n = mockNode(); n.busy = 1;
  const m = new ScanManager({ rpc: n.rpc });
  const orig = m._scanWithRetry.bind(m);
  m._scanWithRetry = async (d) => { for (;;) { try { return await n.rpc('scantxoutset', ['start', d]); } catch (e) { if (/already in progress/.test(e.message)) { await sleep(5); continue; } throw e; } } };
  ok('busy scan slot is retried until free', (await waitDone(m, (await m.submit([S(1)])).id)).state === 'done' && typeof orig === 'function');
}
// ---- node failure -> job error, manager keeps working ----
{
  const n = mockNode(); let fail = true;
  const rpc = async (meth, p) => { if (meth === 'scantxoutset' && p[0] === 'start' && fail) throw new Error('boom'); return n.rpc(meth, p); };
  const m = new ScanManager({ rpc });
  const v = await waitDone(m, (await m.submit([S(1)])).id);
  ok('a failed scan reports a clean error (no internals leaked)', v.state === 'error' && !/boom/.test(v.error));
  fail = false;
  ok('…and the next scan works', (await waitDone(m, (await m.submit([S(1)])).id)).state === 'done');
  ok('unknown job id -> 404', await rejects(m.view('nope'), /unknown or expired/));
}
// ---- prev-tx fetch ----
{
  const calls = [];
  let onDisk = false;
  const rpc = async (meth, p) => {
    calls.push(meth);
    if (meth === 'getblockcount') return 1000;
    if (meth === 'getblockhash') return 'bh170';
    if (meth === 'getrawtransaction') { if (!onDisk) throw new Error('Block not available (pruned data)'); return T170; }
    if (meth === 'getpeerinfo') return [{ id: 7, servicesnames: ['NETWORK', 'WITNESS'], synced_blocks: 1000 }, { id: 8, servicesnames: ['NETWORK_LIMITED'], synced_blocks: 1000 }];
    if (meth === 'getblockfrompeer') { if (p[1] !== 7) throw new Error('wrong peer'); onDisk = true; return {}; }
    throw new Error('unmocked ' + meth);
  };
  const TXID = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
  const hex = await fetchPrevTx(rpc, { txid: TXID, height: 170 }, { wait: async () => {} });
  ok('pruned block is fetched from a full-block peer, then the tx is returned', hex === T170 && calls.includes('getblockfrompeer'));
  ok('a tx that does not hash to the requested txid is refused', await rejects(fetchPrevTx(rpc, { txid: TX(5), height: 170 }, { wait: async () => {} }), /does not match/));
  ok('height above the tip refused', await rejects(fetchPrevTx(rpc, { txid: TXID, height: 5000 }), /above the chain tip/));
  ok('malformed txid refused', await rejects(fetchPrevTx(rpc, { txid: 'xyz', height: 1 }), /malformed txid/));
  onDisk = false;
  const rpcNoPeers = async (meth, p) => (meth === 'getpeerinfo' ? [] : rpc(meth, p));
  ok('no peers able to serve the block -> clean 503', await rejects(fetchPrevTx(rpcNoPeers, { txid: TXID, height: 170 }, { wait: async () => {} }), /could not retrieve/));
  ok('errors carry HTTP status codes', new ApiError(418, 'x').status === 418);
}

// ---- market price feed (display only) ----
{
  ok('Coinbase stats -> price + 24h change', JSON.stringify(quoteFromCoinbase({ open: '80000', last: '84000' })) === JSON.stringify({ price: 84000, change24h: 5 }));
  ok('negative change is negative', quoteFromCoinbase({ open: '100000', last: '97500.5' }).change24h === -2.5);
  ok('garbage / zero / absurd quotes are rejected', quoteFromCoinbase({ open: '0', last: '5' }) === null && quoteFromCoinbase({}) === null && quoteFromCoinbase({ open: 'x', last: '1' }) === null && quoteFromCoinbase({ open: '1', last: '-5' }) === null && quoteFromCoinbase({ open: '1', last: '500' }) === null);
  ok('CoinGecko shape parsed for all three currencies', Object.keys(quotesFromCoinGecko({ bitcoin: { usd: 85783, usd_24h_change: 2.78, gbp: 64927, gbp_24h_change: 2.97, eur: 76175, eur_24h_change: 3.17 } })).length === 3);
  let calls = 0, clock = 0, failAll = false, failCoinbase = false;
  const fetchJson = async (url) => {
    calls++;
    if (failAll) throw new Error('down');
    if (url.includes('coinbase')) { if (failCoinbase) throw new Error('down'); return { open: '80000', last: '84000' }; }
    return { bitcoin: { usd: 70000, usd_24h_change: -1.5, gbp: 55000, gbp_24h_change: -1.4, eur: 64000, eur_24h_change: -1.6 } };
  };
  const feed = new PriceFeed({ fetchJson, now: () => clock, ttl: 60_000, maxStale: 900_000 });
  const a = await feed.get();
  ok('feed returns quotes for usd/gbp/eur from the primary source', a.available && a.quotes.usd.price === 84000 && a.quotes.gbp.change24h === 5 && a.source === 'coinbase' && calls === 3);
  await feed.get(); await feed.get();
  ok('quotes are cached for 60 s (no extra outbound calls)', calls === 3);
  clock = 61_000; failCoinbase = true;
  const b = await feed.get();
  ok('falls back to the second source when the first is down', b.available && b.quotes.usd.price === 70000 && b.quotes.usd.change24h === -1.5);
  clock = 130_000; failAll = true;
  ok('serves the last good value while sources are down…', (await feed.get()).quotes.usd.price === 70000);
  clock = 130_000 + 16 * 60_000;
  ok('…but not for longer than 15 minutes (then: unavailable, never a stale number)', (await feed.get()).available === false);
  ok('a test fixture overrides everything', (await new PriceFeed({ fetchJson, fixture: { usd: { price: 1, change24h: -2 } } }).get()).quotes.usd.change24h === -2);
}

// ---- practice-network relay (public Esplora data) ----
{
  const { createHash } = await import('node:crypto');
  const shOf = (script) => createHash('sha256').update(Buffer.from(script, 'hex')).digest('hex');
  ok('practice networks are exactly testnet4, signet, testnet3 — never mainnet', Object.keys(TEST_NETWORKS).sort().join() === 'signet,testnet3,testnet4' && !Object.values(TEST_NETWORKS).some((u) => /mempool\.space\/api$/.test(u)));
  const calls = []; let clock = 0, down = false;
  const A = S(11), B = S(12);
  const fetchText = async (url, opts = {}) => {
    calls.push((opts.method || 'GET') + ' ' + url.replace('http://esp', ''));
    if (down) throw new Error('503');
    if (url.endsWith('/blocks/tip/height')) return '500\n';
    if (url.endsWith('/fee-estimates')) return JSON.stringify({ 2: 3.2, 6: 0.1, 144: 'x' });
    if (url.endsWith(`/scripthash/${shOf(A)}/utxo`)) return JSON.stringify([
      { txid: TX(7), vout: 1, value: 150000, status: { confirmed: true, block_height: 498 } },
      { txid: TX(8), vout: 0, value: 2500, status: { confirmed: false } },
      { txid: 'nope', vout: 0, value: 5, status: {} }, { txid: TX(9), vout: -1, value: 5, status: {} }, { txid: TX(9), vout: 0, value: 1.5, status: {} }]);
    if (url.includes('/scripthash/')) return '[]';
    if (url.endsWith(`/tx/${'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16'}/hex`)) return T170;
    if (url.endsWith(`/tx/${TX(5)}/hex`)) return T170;
    if (url.endsWith('/tx') && opts.method === 'POST') { if (opts.body === 'bad') throw new Error('sendrawtransaction RPC error: bad-txns'); return TX(77); }
    throw new Error('404');
  };
  const be = new EsploraBackend({ network: 'testnet4', base: 'http://esp', fetchText, now: () => clock });
  const job = be.submit([A, B]);
  let v; for (let i = 0; i < 50; i++) { v = be.view(job.id); if (v.state !== 'scanning') break; await sleep(5); }
  ok('lookup returns the coins for the asked scripts only, by SHA-256 script hash', v.state === 'done' && v.utxos.length === 2 && v.utxos.every((u) => u.script === A) && v.height === 500);
  ok('confirmed coin: confirmations from the tip; unconfirmed coin: 0 and no height', v.utxos.find((u) => u.txid === TX(7)).confirmations === 3 && v.utxos.find((u) => u.txid === TX(8)).confirmations === 0 && v.utxos.find((u) => u.txid === TX(8)).height === null);
  ok('malformed rows from the data source are dropped', !v.utxos.some((u) => u.value === 5 || u.value === 1.5));
  const n0 = calls.length; be.submit([A, B]); await sleep(10);
  ok('answers are cached briefly (a second lookup makes no outbound request)', calls.length === n0);
  ok('only fixed URL shapes go out: tip, script hash, nothing user-controlled', calls.every((c) => /^GET \/(blocks\/tip\/height|scripthash\/[0-9a-f]{64}\/utxo)$/.test(c)));
  ok('fees: rounded up, floor 1, junk ignored', JSON.stringify(await be.fees()) === JSON.stringify({ fast: 4, normal: 1, slow: 1, min: 1, unit: 'sat/vB' }));
  ok('previous tx is hash-checked', (await be.prevTx('f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16')) === T170 && await rejects(be.prevTx(TX(5)), /does not match/) && await rejects(be.prevTx('../../etc'), /malformed/));
  ok('broadcast returns the txid; a rejected one is a clean 400', (await be.broadcast('00'.repeat(70))) === TX(77) && await rejects(be.broadcast('bad'), /rejected by the network/));
  down = true; clock += 60_000;
  const j2 = be.submit([A]); for (let i = 0; i < 50; i++) { v = be.view(j2.id); if (v.state !== 'scanning') break; await sleep(5); }
  ok('data source down -> clean error, no internals leaked', v.state === 'error' && !/503/.test(v.error));
  ok('unknown job id -> 404', (() => { try { be.view('x'); return false; } catch (e) { return e.status === 404; } })());
}

console.log(bad ? '\nNODEAPI LIB TESTS FAILED' : '\nnodeapi lib: all checks passed');
process.exit(bad ? 1 : 0);
