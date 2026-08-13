// RT-6 — Nostr crash-replay dedup tests.
//
// Proves: an event id is durable BEFORE any payout; a crash at any point cannot turn one
// event into multiple payouts; corrupt/unreadable state fails safe (refuse, never replay);
// a persist failure is treated as "not recorded" (skip, don't pay); restart preserves state.
import { DedupStore } from '../nostr/dedup.mjs';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(68), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const dir = mkdtempSync(join(tmpdir(), 'rt6-dedup-'));
let n = 0;
const freshFile = () => join(dir, `state${++n}.json`);

// A minimal stand-in for the bot's handler ordering, with an injectable crash point.
// `world.claims` is the payout log — the thing that must never grow past 1 per event.
function makeHandle(store, world) {
  const ev = { id: 'evt-1', pubkey: 'npub-A', mentionsUs: true, validSig: true };
  return async ({ crashAt } = {}) => {
    if (!store.healthy) return 'refused';                 // corrupt dedup -> fail closed
    if (store.has(ev.id)) return 'skip-dupe';             // already consumed
    if (!ev.mentionsUs || !ev.validSig) return 'skip';
    if (!store.markSeenDurable(ev.id)) return 'persist-fail';  // durable BEFORE payout
    if (crashAt === 'after-persist-before-payout') throw new Error('CRASH');
    world.claims.push(ev.id);                             // THE payout (payout-capable action)
    if (crashAt === 'after-payout') throw new Error('CRASH');
    store.setClaim(ev.pubkey, 1000);
    return 'paid';
  };
}

// ── basic durability: markSeenDurable persists; reload sees it ──
{
  const f = freshFile();
  const s = new DedupStore(f);
  ok('healthy on empty start', s.healthy === true && s.has('x') === false);
  ok('markSeenDurable returns true (on disk)', s.markSeenDurable('x') === true);
  const s2 = new DedupStore(f);   // "restart"
  ok('reload sees the durably-recorded id', s2.has('x') === true);
}

// ── crash BEFORE dedup persistence: nothing recorded, no payout happened ──
{
  const f = freshFile();
  const s = new DedupStore(f);
  // (we simply never call markSeenDurable — models a crash before it)
  const s2 = new DedupStore(f);
  ok('crash before persist -> id NOT seen on restart', s2.has('evt-1') === false);
}

// ── crash AFTER persist, BEFORE payout: reload skips; ZERO payouts, no double ──
{
  const f = freshFile();
  const world = { claims: [] };
  let threw = false;
  try { await makeHandle(new DedupStore(f), world)({ crashAt: 'after-persist-before-payout' }); } catch { threw = true; }
  ok('crash after persist/before payout throws', threw);
  ok('...no payout happened yet', world.claims.length === 0);
  const res = await makeHandle(new DedupStore(f), world)();   // redelivery after restart
  ok('...redelivery is skipped as duplicate', res === 'skip-dupe');
  ok('...still ZERO payouts (safe; user may resend)', world.claims.length === 0);
}

// ── crash AFTER payout: reload skips; EXACTLY ONE payout (the core invariant) ──
{
  const f = freshFile();
  const world = { claims: [] };
  let threw = false;
  try { await makeHandle(new DedupStore(f), world)({ crashAt: 'after-payout' }); } catch { threw = true; }
  ok('crash after payout throws', threw);
  ok('...exactly one payout recorded pre-crash', world.claims.length === 1);
  const res = await makeHandle(new DedupStore(f), world)();   // redelivery after restart
  ok('...redelivery is skipped as duplicate', res === 'skip-dupe');
  ok('PRIMARY INVARIANT: one event -> exactly one payout across a crash', world.claims.length === 1);
}

// ── no crash, relay re-delivers the same event: still exactly one payout ──
{
  const f = freshFile();
  const world = { claims: [] };
  const h = makeHandle(new DedupStore(f), world);
  ok('first delivery pays', (await h()) === 'paid' && world.claims.length === 1);
  ok('redelivery (same store) is a no-op', (await h()) === 'skip-dupe' && world.claims.length === 1);
}

// ── corrupt/unreadable state FAILS SAFE: unhealthy, refuses, does NOT reset+replay ──
{
  const f = freshFile();
  writeFileSync(f, '{ this is not: valid json');
  const s = new DedupStore(f);
  ok('corrupt state -> store UNHEALTHY', s.healthy === false && !!s.loadError);
  ok('corrupt state -> markSeenDurable refuses (false)', s.markSeenDurable('evt-1') === false);
  const world = { claims: [] };
  ok('corrupt state -> handler REFUSES to dispense (fail closed)', (await makeHandle(s, world)()) === 'refused' && world.claims.length === 0);
  // a structurally-wrong-but-parseable file is also treated as corrupt
  const f2 = freshFile(); writeFileSync(f2, JSON.stringify({ seen: 'nope', claims: 5 }));
  ok('malformed (wrong types) -> UNHEALTHY too', new DedupStore(f2).healthy === false);
}

// ── persist FAILURE is treated as not-recorded: skip, do not pay, id not retained ──
{
  const wedge = join(dir, 'wedge'); writeFileSync(wedge, 'file-not-dir');
  const badFile = join(wedge, 'nested', 'state.json');   // parent is a file -> fs ops throw
  const s = new DedupStore(badFile);                     // does not exist -> healthy empty
  ok('unwritable target still loads healthy-empty', s.healthy === true);
  ok('markSeenDurable returns FALSE when persist fails', s.markSeenDurable('evt-1') === false);
  ok('...and the id is NOT retained in memory (retry possible)', s.has('evt-1') === false);
  const world = { claims: [] };
  ok('handler with failing persist -> skips, NO payout', (await makeHandle(s, world)()) === 'persist-fail' && world.claims.length === 0);
}

// ── restart preserves per-account claim times + seen set ──
{
  const f = freshFile();
  const s = new DedupStore(f);
  s.markSeenDurable('a'); s.markSeenDurable('b'); s.setClaim('npub-Z', 123456);
  const s2 = new DedupStore(f);
  ok('restart preserves seen ids', s2.has('a') && s2.has('b'));
  ok('restart preserves claim timestamps', s2.getClaim('npub-Z') === 123456);
}

console.log(bad ? '\nRT-6 DEDUP TEST FAILED' : '\nRT-6 DEDUP TEST PASS — dedup durable-before-payout, crash-safe, corrupt-safe, one-event-one-payout');
process.exit(bad ? 1 : 0);
