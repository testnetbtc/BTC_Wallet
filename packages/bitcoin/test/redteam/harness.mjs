// RED-TEAM HARNESS (assessment only — makes NO changes to production state).
// Probes wallet input handling, the circuit-breaker under malformed config, and
// telemetry/dashboard robustness. Prints structured evidence lines:
//   ok:      behaved safely (rejected / fail-closed / no crash)
//   VULN:    behaved unsafely (accepted hostile input / fail-open / crash)
//   note:    observed behaviour worth recording
import { deriveScript } from '../../src/scripts.js';
import { buildSignedTx } from '../../src/tx.js';
import { VelocityBreaker } from '../../faucet/breaker.mjs';
import { warningLevel, redact, breakerView, heartbeatStatus } from '../../faucet/telemetry.mjs';

const line = (tag, msg) => console.log(tag.padEnd(6) + msg);
const SEED = 'rib crew brief brave outer knee arch flee sign fold silk fuel';

console.log('\n===== §1 WALLET / SIGNING — hostile destination addresses (testnet4 builder) =====');
{
  const key = deriveScript(SEED, 'testnet4', 'p2wpkh', 0);
  const utxos = [{ txid: '11'.repeat(32), vout: 0, value: 100000 }];
  const HOSTILE = [
    ['mainnet addr on testnet', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['wrong-net legacy', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'],
    ['bech32 bad checksum', 'tb1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqx'],
    ['bech32 mixed case', 'Tb1Qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'],
    ['unknown witness v17', 'tb1sqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx7l7'],
    ['whitespace wrap', '  tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx  '],
    ['unicode confusable', 'tb1qw508d6qejxtdg4y5r3zarvɑry0c5xw7kxpjzsx'],
    ['oversized garbage', 'tb1' + 'q'.repeat(4000)],
    ['empty', ''],
    ['not an address', 'send-me-money'],
    ['script-as-address', 'OP_DUP OP_HASH160'],
  ];
  for (const [label, addr] of HOSTILE) {
    try {
      const r = buildSignedTx({ utxos, key, recipients: [{ address: addr, amount: 20000 }], changeAddress: key.address, feeRate: 2, networkName: 'testnet4' });
      line('VULN', `accepted hostile address [${label}] -> txid ${r.txid.slice(0, 12)} (produced an output!)`);
    } catch (e) { line('ok', `rejected [${label}]: ${String(e.message).slice(0, 60)}`); }
  }
}

console.log('\n===== §1 WALLET — hostile output values =====');
{
  const key = deriveScript(SEED, 'testnet4', 'p2wpkh', 0);
  const utxos = [{ txid: '11'.repeat(32), vout: 0, value: 100000 }];
  const good = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const VALUES = [['zero', 0], ['negative', -1], ['float', 0.5], ['dust 1sat', 1], ['huge > 21M BTC', 2100000000000001], ['string', '20000'], ['NaN', NaN], ['bigint-ish', 9007199254740993]];
  for (const [label, amount] of VALUES) {
    try {
      const r = buildSignedTx({ utxos, key, recipients: [{ address: good, amount }], changeAddress: key.address, feeRate: 2, networkName: 'testnet4' });
      const out = r; line('note', `value [${label}=${amount}] -> built txid ${r.txid.slice(0, 10)} vsize ${r.vsize} (accepted)`);
    } catch (e) { line('ok', `value [${label}=${amount}] rejected: ${String(e.message).slice(0, 55)}`); }
  }
  // duplicate outputs
  try { const r = buildSignedTx({ utxos, key, recipients: [{ address: good, amount: 20000 }, { address: good, amount: 20000 }], changeAddress: key.address, feeRate: 2, networkName: 'testnet4' }); line('note', `duplicate outputs -> accepted (${r.vsize} vB) [normal: two outputs to same addr is legal]`); }
  catch (e) { line('ok', `duplicate outputs rejected: ${e.message.slice(0, 40)}`); }
  // duplicate inputs (same outpoint twice)
  try { const r = buildSignedTx({ utxos: [utxos[0], utxos[0]], key, recipients: [{ address: good, amount: 20000 }], changeAddress: key.address, feeRate: 2, networkName: 'testnet4' }); line('VULN', `DUPLICATE INPUT accepted -> txid ${r.txid.slice(0, 12)} (double-spend of one outpoint in a tx)`); }
  catch (e) { line('ok', `duplicate input rejected: ${e.message.slice(0, 50)}`); }
}

console.log('\n===== §8 CIRCUIT-BREAKER — malformed configuration (fail-open probe) =====');
{
  const burst = (b) => { let allowed = 0; for (let i = 0; i < 200; i++) if (b.authorize({ address: 'a' + i, sats: 1, utxos: 1, fee: 1 }, 1e6).ok) allowed++; return { allowed, tripped: b.tripped }; };
  const cases = [
    ['string limit "abc"', { maxClaimsPerMin: 'abc' }],
    ['NaN limit', { maxClaimsPerMin: NaN }],
    ['null limit', { maxClaimsPerMin: null }],
    ['negative limit -5', { maxClaimsPerMin: -5 }],
    ['zero limit 0', { maxClaimsPerMin: 0 }],
    ['boolean true', { maxClaimsPerMin: true }],
    ['array', { maxClaimsPerMin: [30] }],
    ['object', { maxClaimsPerMin: { n: 30 } }],
    ['Infinity', { maxClaimsPerMin: Infinity }],
  ];
  for (const [label, limits] of cases) {
    // isolate all other metrics huge so ONLY claims matters
    const b = new VelocityBreaker({ persist: false, alert: () => {}, limits: { maxSatsPerMin: 1e18, maxDistinctAddrPerMin: 1e18, maxUtxosPerMin: 1e18, maxFeePerMin: 1e18, maxFailuresPerMin: 1e18, ...limits } });
    const r = burst(b);
    const failOpen = r.allowed === 200 && !r.tripped; // all 200 authorised, never tripped
    line(failOpen ? 'VULN' : 'ok', `claims limit=${label}: authorised ${r.allowed}/200, tripped=${r.tripped}` + (failOpen ? '  <-- FAIL-OPEN (metric disabled, no trip)' : ''));
  }
}

console.log('\n===== §9/§15 TELEMETRY & DASHBOARD — robustness / fail-open display =====');
{
  // breakerView on garbage should not crash, and should NOT show RUNNING for unknown state
  const garbage = [undefined, null, {}, { metrics: null, limits: null }, { tripped: 'yes' }, { metrics: { claims: -5 }, limits: { maxClaimsPerMin: -1 } }, { metrics: { claims: 1e30 }, limits: { maxClaimsPerMin: NaN } }];
  for (const g of garbage) {
    try { const v = breakerView(g); line('note', `breakerView(${JSON.stringify(g)?.slice(0, 40)}) -> state=${v.state}, ${v.metrics.length} rows (no crash)`); }
    catch (e) { line('VULN', `breakerView crashed on ${JSON.stringify(g)?.slice(0, 30)}: ${e.message}`); }
  }
  line('note', 'DASHBOARD FAIL-OPEN: breakerView(undefined).state = ' + breakerView(undefined).state + '  (missing/corrupt telemetry shows RUNNING, not UNKNOWN)');
  // warningLevel with hostile numeric inputs
  for (const [v, l] of [[NaN, 30], [-5, 30], [1e30, 30], [5, NaN], [5, -1], [5, 0], [Infinity, 30]]) {
    try { line('note', `warningLevel(${v},${l}) = ${warningLevel(v, l)} (no crash)`); } catch (e) { line('VULN', `warningLevel crashed: ${e.message}`); }
  }
  // heartbeat: far-future / far-past / garbage
  const now = 1e6;
  for (const [label, beat] of [['future', { t: now + 1e9 }], ['past', { t: 0 }], ['string t', { t: 'soon' }], ['garbage', { foo: 1 }], ['array', [1, 2]]]) {
    try { const h = heartbeatStatus(beat, 5000, now); line('note', `heartbeat[${label}] -> present=${h.present} stale=${h.stale} age=${h.ageMs}`); }
    catch (e) { line('VULN', `heartbeatStatus crashed on ${label}: ${e.message}`); }
  }
}

console.log('\n===== §11 REDACTION — canary secrets across key shapes =====');
{
  const CANARY = 'CANARY_c0ffee_do_not_leak';
  const payload = redact({
    rpcPassword: CANARY, rpc_password: CANARY, RPCPASSWORD: CANARY, botToken: CANARY, token: CANARY,
    seed: CANARY, mnemonic: CANARY, privkey: CANARY, xprv: CANARY, authorization: CANARY, cookie: CANARY,
    apiKey: CANARY, credentials: CANARY,
    // shapes that DON'T match the key regex -> would leak if a value carried a secret:
    note: CANARY, address: CANARY, description: 'balance', data: { inner_secret_value: CANARY },
  });
  const flat = JSON.stringify(payload);
  const leaks = (flat.match(new RegExp(CANARY, 'g')) || []).length;
  line(leaks === 0 ? 'ok' : 'note', `redact left ${leaks} canary occurrence(s). Keys that leaked (value-in-non-secret-key): ` +
    Object.entries(payload).filter(([k, v]) => v === CANARY).map(([k]) => k).join(', ') + ' + data.inner_secret_value=' + payload.data.inner_secret_value);
}
console.log('\n===== harness complete =====');
