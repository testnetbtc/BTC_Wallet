// RT-2 ledger unit tests: schema/health, idempotent entitlement, durable reservation
// uniqueness, controlled transitions, durability across reopen.
import { ClaimLedger, S, claimDayUTC, transitionAllowed } from '../faucet/ledger.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(60), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const dir = mkdtempSync(join(tmpdir(), 'rt2-ledger-'));
const FILE = join(dir, 'claims.db');
const DAY = claimDayUTC(Date.UTC(2026, 7, 13, 12, 0, 0));

let led = new ClaimLedger(FILE);
ok('ledger opens healthy', led.health().healthy === true);

// entitlement idempotency
const c1 = led.createAuthorised({ claimId: 'c1', network: 'testnet4', address: 'tb1qaaa', canon: 'aa', claimDay: DAY, amountSat: 100000, reserveOutpoints: [{ txid: '11'.repeat(32), vout: 0 }] });
ok('first claim created', c1.created === true && c1.claim.state === S.AUTHORISED);
const c1b = led.createAuthorised({ claimId: 'c1-again', network: 'testnet4', address: 'TB1QAAA', canon: 'aa', claimDay: DAY, amountSat: 100000, reserveOutpoints: [{ txid: '22'.repeat(32), vout: 0 }] });
ok('duplicate entitlement -> NOT created, returns existing claim', c1b.created === false && c1b.claim.claim_id === 'c1' && c1b.reason === 'entitlement-exists');

// reservation uniqueness: a different entitlement cannot grab c1's reserved outpoint
const c2 = led.createAuthorised({ claimId: 'c2', network: 'testnet4', address: 'tb1qbbb', canon: 'bb', claimDay: DAY, amountSat: 100000, reserveOutpoints: [{ txid: '11'.repeat(32), vout: 0 }] });
ok('reservation conflict blocks reusing an outpoint', c2.created === false && c2.reason === 'reservation-conflict');
const c2ok = led.createAuthorised({ claimId: 'c2', network: 'testnet4', address: 'tb1qbbb', canon: 'bb', claimDay: DAY, amountSat: 100000, reserveOutpoints: [{ txid: '33'.repeat(32), vout: 0 }] });
ok('distinct outpoint -> second claim created', c2ok.created === true);

// controlled transitions
ok('transition matrix: AUTHORISED->SIGNED allowed', transitionAllowed(S.AUTHORISED, S.SIGNED));
ok('transition matrix: CONFIRMED->AUTHORISED forbidden', !transitionAllowed(S.CONFIRMED, S.AUTHORISED));
ok('transition matrix: SIGNED->new-tx (there is none) i.e. SIGNED->AUTHORISED forbidden', !transitionAllowed(S.SIGNED, S.AUTHORISED));
led.markSigned('c1', { rawTx: 'deadbeef', localTxid: 'ff'.repeat(32), feeSat: 300, reservedOutpoints: [{ txid: '11'.repeat(32), vout: 0 }] });
ok('markSigned persists raw_tx + local_txid', (() => { const c = led.get('c1'); return c.state === S.SIGNED && c.raw_tx === 'deadbeef' && c.local_txid === 'ff'.repeat(32); })());
led.markBroadcasting('c1');
ok('markBroadcasting bumps attempt count + timestamps', (() => { const c = led.get('c1'); return c.state === S.BROADCASTING && c.broadcast_attempt_count === 1 && c.first_broadcast_at; })());
led.markSeen('c1'); led.markConfirmed('c1', { height: 100, blockHash: 'bh' });
ok('SEEN->CONFIRMED terminal', led.get('c1').state === S.CONFIRMED);
let threw = false; try { led.transition('c1', S.AUTHORISED); } catch { threw = true; }
ok('illegal transition from CONFIRMED throws', threw);

// FAILED_SAFE reachable from anywhere
led.markFailedSafe('c2', 'txid-mismatch', 'stored txid != computed');
ok('markFailedSafe forces terminal safe state', led.get('c2').state === S.FAILED_SAFE);

// counts + non-terminal + active reservations
const counts = led.counts();
ok('counts reflect states', counts.CONFIRMED === 1 && counts.FAILED_SAFE === 1);
ok('non-terminal excludes CONFIRMED/FAILED_SAFE', led.nonTerminal().length === 0);

// durability: reopen the same file, claims survive
led.close();
led = new ClaimLedger(FILE);
ok('claims survive reopen (durable)', led.get('c1').state === S.CONFIRMED && led.get('c2').state === S.FAILED_SAFE);
ok('entitlement still enforced after reopen', led.createAuthorised({ claimId: 'x', network: 'testnet4', address: 'tb1qaaa', canon: 'aa', claimDay: DAY, amountSat: 100000, reserveOutpoints: [] }).created === false);
led.close();

console.log(bad ? '\nLEDGER TEST FAILED' : '\nLEDGER TEST PASS — durable, idempotent, reservation-safe, transition-controlled');
process.exit(bad ? 1 : 0);
