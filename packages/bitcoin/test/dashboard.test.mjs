// Tests for the read-only dashboard: pure telemetry helpers, redaction (no secret
// can surface), read-only HTTP behaviour, and inert rendering of hostile content.
import { warningLevel, redact, breakerView, heartbeatStatus, dashboardStatus, scrubValue } from '../faucet/telemetry.mjs';
import { server, PAGE } from '../faucet/dashboard.mjs';

let bad = 0;
const ok = (label, cond) => { console.log(label.padEnd(62), cond ? '✓' : '✗ FAIL'); if (!cond) bad = true; };

// ── warning levels ──
ok('warn: 0/30 → normal', warningLevel(0, 30) === 'normal');
ok('warn: 14/30 (<50%) → normal', warningLevel(14, 30) === 'normal');
ok('warn: 15/30 (50%) → elevated', warningLevel(15, 30) === 'elevated');
ok('warn: 25/30 (>80%) → near', warningLevel(25, 30) === 'near');
ok('warn: 30/30 (100%) → over', warningLevel(30, 30) === 'over');
ok('warn: tripped flag → tripped', warningLevel(1, 30, true) === 'tripped');
ok('warn: zero limit → normal (no divide-by-zero)', warningLevel(5, 0) === 'normal');

// ── redaction: secrets never surface, benign fields preserved ──
{
  const dirty = {
    address: 'tb1qpublic', balanceSat: 123, rpcPassword: 'hunter2', rpcUser: 'bob',
    node: { token: 'abc', authorization: 'Basic xyz', peers: 9 },
    telegram: { botToken: 'SECRET', adminChatId: 5 },
    list: [{ mnemonic: 'twelve words', ok: 1 }],
  };
  const clean = redact(dirty);
  const flat = JSON.stringify(clean);
  ok('redact: rpcPassword removed', clean.rpcPassword === '[redacted]');
  ok('redact: rpcUser removed', clean.rpcUser === '[redacted]');
  ok('redact: nested token removed', clean.node.token === '[redacted]');
  ok('redact: nested authorization removed', clean.node.authorization === '[redacted]');
  ok('redact: botToken removed', clean.telegram.botToken === '[redacted]');
  ok('redact: mnemonic in array removed', clean.list[0].mnemonic === '[redacted]');
  ok('redact: NONE of the secret VALUES survive anywhere', !/hunter2|Basic xyz|SECRET|twelve words|abc/.test(flat.replace(/\[redacted\]/g, '')));
  ok('redact: benign fields preserved', clean.address === 'tb1qpublic' && clean.balanceSat === 123 && clean.node.peers === 9);
}

// ── RT-9: value-shape scrubbing (defence in depth) — secrets under BENIGN keys are
//    masked, but real Bitcoin/diagnostic values are NEVER touched ──
{
  const txid = 'deadbeef'.repeat(8);                                   // 64-hex txid
  const blockhash = '00000000000000000000' + 'a1b2c3d4'.repeat(5) + 'abcd';  // 64-hex block hash
  const addr = 'tb1qtzn8he625xdtdc63nu08jcwmk29080nvyga9dn';           // bech32 address
  const pubkey = '02' + 'ab'.repeat(32);                               // 66-hex compressed pubkey
  const xpub = 'xpub' + 'A'.repeat(107);                               // extended PUBLIC key (not secret)
  const sha = 'f'.repeat(64);                                          // ordinary diagnostic hash

  // must be PRESERVED (bias to under-scrubbing)
  ok('RT-9: txid preserved (64-hex is not secret)', scrubValue(txid) === txid);
  ok('RT-9: block hash preserved', scrubValue(blockhash) === blockhash);
  ok('RT-9: bech32 address preserved', scrubValue(addr) === addr);
  ok('RT-9: compressed public key preserved', scrubValue(pubkey) === pubkey);
  ok('RT-9: extended PUBLIC key (xpub) preserved', scrubValue(xpub) === xpub);
  ok('RT-9: ordinary hash preserved', scrubValue(sha) === sha);

  // must be MASKED (unmistakable secret shapes)
  // assembled at runtime (NOT a literal) so GitHub secret-scanning doesn't flag this fake fixture
  const botTok = '987654321' + ':' + 'AAH' + 'dummyTokenValue1234567890abcdef';
  const xprv = 'xprv' + '9'.repeat(110);
  const tprv = 'tprv' + 'q'.repeat(110);
  const nsec = 'nsec1' + 'q'.repeat(58);
  const pem = '-----BEGIN EC ' + 'PRIVATE KEY-----\n' + 'MHQCAQEEIabc123deadbeef' + '\n-----END EC -----';   // assembled fake, not a literal key block
  ok('RT-9: Telegram bot token masked', scrubValue(botTok) === '[redacted]');
  ok('RT-9: xprv extended private key masked', scrubValue(xprv) === '[redacted]');
  ok('RT-9: tprv extended private key masked', scrubValue(tprv) === '[redacted]');
  ok('RT-9: nsec secret key masked', scrubValue(nsec) === '[redacted]');
  ok('RT-9: PEM private-key block masked', scrubValue(pem) === '[redacted]');
  ok('RT-9: Bearer credential masked', scrubValue('Bearer abcdef1234567890XYZ').includes('[redacted]'));
  ok('RT-9: Basic credential masked', scrubValue('Basic dXNlcjpodW50ZXIyMDAw').includes('[redacted]'));

  // embedded secret in free text: token masked, surrounding txid still visible
  const mixed = scrubValue(`payout failed, bot ${botTok} for tx ${txid}`);
  ok('RT-9: embedded secret masked but txid in same string preserved', !mixed.includes(botTok) && mixed.includes(txid));

  // integration through redact(): a secret under a benign key name is scrubbed by value,
  // while allowlisted key-name redaction still applies.
  const clean = redact({ note: `see ${botTok}`, address: addr, rpcPassword: 'hunter2', txid });
  ok('RT-9: redact() scrubs secret VALUE under benign key', !JSON.stringify(clean.note).includes(botTok));
  ok('RT-9: redact() keeps address + txid visible', clean.address === addr && clean.txid === txid);
  ok('RT-9: redact() still redacts by key name (primary)', clean.rpcPassword === '[redacted]');
}

// ── breaker view maps all six metrics to value/limit/level ──
{
  const status = {
    tripped: false, trip: null,
    limits: { maxClaimsPerMin: 30, maxSatsPerMin: 3_000_000, maxDistinctAddrPerMin: 30, maxUtxosPerMin: 60, maxFeePerMin: 200_000, maxFailuresPerMin: 60 },
    metrics: { claims: 24, sats: 100, utxos: 1, fee: 1, distinctAddrs: 3, failures: 0 },
  };
  const v = breakerView(status);
  ok('breakerView: state RUNNING when not tripped', v.state === 'RUNNING');
  ok('breakerView: six metric rows', v.metrics.length === 6);
  ok('breakerView: claims 24/30 → near', v.metrics.find((m) => m.key === 'claims').level === 'near');
  const tv = breakerView({ ...status, tripped: true, trip: { metric: 'claimsPerMin' } });
  ok('breakerView: state TRIPPED when tripped', tv.state === 'TRIPPED');
}

// ── RT-3: dashboard status never fails open to RUNNING when telemetry is untrustworthy ──
{
  const S = 15000;
  ok('RT-3: unreadable telemetry -> UNKNOWN (not RUNNING)', dashboardStatus({ readable: false, ageMs: null, tripped: false }, S) === 'UNKNOWN');
  ok('RT-3: stale telemetry -> STALE (not RUNNING)', dashboardStatus({ readable: true, ageMs: 60000, tripped: false }, S) === 'STALE');
  ok('RT-3: null age -> STALE', dashboardStatus({ readable: true, ageMs: null, tripped: false }, S) === 'STALE');
  ok('RT-3: fresh + tripped -> TRIPPED', dashboardStatus({ readable: true, ageMs: 1000, tripped: true }, S) === 'TRIPPED');
  ok('RT-3: fresh + not tripped -> RUNNING', dashboardStatus({ readable: true, ageMs: 1000, tripped: false }, S) === 'RUNNING');
  ok('RT-3: a down faucet (stale) never reads RUNNING', dashboardStatus({ readable: true, ageMs: 3600000, tripped: false }, S) !== 'RUNNING');
  // RT-2: an unhealthy claim ledger must never read RUNNING
  ok('RT-2: ledger unhealthy -> DEGRADED (not RUNNING)', dashboardStatus({ readable: true, ageMs: 1000, tripped: false, ledgerHealthy: false }, S) === 'DEGRADED');
  ok('RT-2: ledger healthy + fresh + untripped -> RUNNING', dashboardStatus({ readable: true, ageMs: 1000, tripped: false, ledgerHealthy: true }, S) === 'RUNNING');
  ok('RT-2: tripped outranks ledger state', dashboardStatus({ readable: true, ageMs: 1000, tripped: true, ledgerHealthy: false }, S) === 'TRIPPED');
}

// ── heartbeat staleness ──
{
  const now = 1_000_000;
  ok('heartbeat: fresh → not stale', heartbeatStatus({ t: now - 3000 }, 5000, now).stale === false);
  ok('heartbeat: old → stale', heartbeatStatus({ t: now - 9000 }, 5000, now).stale === true);
  ok('heartbeat: missing → not present', heartbeatStatus(null, 5000, now).present === false);
  // trading-project schema uses an ISO "ts" string, not "t" ms
  const iso = new Date(now - 2000).toISOString();
  ok('heartbeat: ISO ts schema parses (fresh)', heartbeatStatus({ ts: iso, status: 'OK' }, 5000, now).present === true && heartbeatStatus({ ts: iso }, 5000, now).stale === false);
  ok('heartbeat: numeric mtime fallback', heartbeatStatus(now - 1000, 5000, now).present === true);
}

// ── read-only HTTP: POST rejected, /healthz + / served, no secrets in HTML ──
await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = await fetch(base + '/api', { method: 'POST' });
    ok('http: POST is rejected 405 (read-only)', post.status === 405);
    const put = await fetch(base + '/', { method: 'PUT' });
    ok('http: PUT is rejected 405', put.status === 405);
    const hz = await fetch(base + '/healthz');
    ok('http: GET /healthz → 200 ok', hz.status === 200 && (await hz.text()) === 'ok');
    const home = await fetch(base + '/');
    const html = await home.text();
    ok('http: GET / → 200 html', home.status === 200);
    ok('http: HTML sets a nonce-CSP (no unsafe-inline script)', /script-src 'nonce-/.test(home.headers.get('content-security-policy')) && !/script-src[^;]*unsafe-inline/.test(home.headers.get('content-security-policy')));
    ok('http: HTML connect-src is self only', /connect-src 'self'/.test(home.headers.get('content-security-policy')));
    ok('http: served HTML carries no secret-shaped tokens', !/rpcPassword|BEGIN [A-Z ]*PRIVATE KEY|"token"\s*:/.test(html));
    server.close(resolve);
  });
});

// ── hostile content renders as INERT text (no injection) ──
{
  let JSDOM;
  try { ({ JSDOM } = await import('jsdom')); } catch { console.log('render test skipped — jsdom not installed'); }
  if (JSDOM) {
    const evil = '<img src=x onerror=window.__xss=1>deadbeef';
    const payload = {
      now: Date.now(), status: 'RUNNING', telemetryReadable: true, breaker: breakerView({ tripped: false, limits: { maxClaimsPerMin: 30 }, metrics: { claims: 1 } }),
      reservedUtxos: 0, lastPayoutAt: null, startedAt: Date.now(), telemetryAgeMs: 100, drip: 100000,
      networks: ['testnet4'], balances: { testnet4: { balanceSat: 1, confirmedUtxos: 1, bankCoins: 1, unconfirmedUtxos: 0 } },
      recentPayouts: [{ at: Date.now(), network: 'testnet4', address: evil, sats: 100000, state: 'ok' }],
      recentRejects: [{ at: Date.now(), kind: evil }], trips: [], node: { ok: false, error: evil },
      ledger: { healthy: true, error: null, counts: { AUTHORISED: 0, SIGNED: 0, BROADCASTING: 0, SEEN: 2, CONFIRMED: 5, UNCERTAIN: 1, CONFLICTED: 0, FAILED_SAFE: 0 }, oldestNonTerminalAgeMs: 5000 }, recoveryHealthy: true,
      beats: { faucet: { label: 'Faucet', present: true, ageMs: 1000, stale: false } },
    };
    const dom = new JSDOM(PAGE('testnonce'), {
      runScripts: 'dangerously', url: 'http://127.0.0.1/',
      beforeParse(w) { w.__xss = 0; w.fetch = () => Promise.resolve({ json: async () => payload }); },
    });
    await new Promise((r) => setTimeout(r, 250));
    const doc = dom.window.document;
    ok('render: hostile address created NO <img> element', doc.querySelector('#payouts img') === null && doc.querySelector('img') === null);
    ok('render: XSS did not execute (onerror never fired)', dom.window.__xss === 0);
    ok('render: hostile address is present as inert text', doc.querySelector('#payouts').textContent.includes('<img'));
    dom.window.close();
  }
}

console.log(bad ? '\nDASHBOARD TEST FAILED' : '\nDASHBOARD TEST PASS — read-only, redacted, inert rendering');
process.exit(bad ? 1 : 0);
