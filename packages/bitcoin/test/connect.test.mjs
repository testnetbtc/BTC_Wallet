// Wallet ↔ swap CONNECT bridge (app.olesia.io/connect) + injected provider.
// Proves: the built page is hardened + network-less; window.OLESIA_CONNECT serves the two
// hand-off methods over the audited engine (getAccount / review / sign) in a browser env; and
// the provider pins the wallet origin. The HTLC signing correctness itself is covered by
// test/htlc_sign.test.mjs (engine-accepted); this guards the bridge shell + consent surface.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(70), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// wallet-keyed redeem fixture (engine-produced PSBT; redeem key = this wallet's m/84'/1'/0'/0/0)
const WK_REDEEM = { txid: '11947e0518110f27c3291758f0f332b6d4782a2cac4e448f879d3ac81d3fc9fa', secret: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', psbt: 'cHNidP8BAF4CAAAAAaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAAAAAAD/////AUyaAAAAAAAAIgAgsk/1pQpR4/OLn19mjxXrJ6/qPMj7HmP3cdJmTC+cr0QAAAAAAAEBK0CcAAAAAAAAIgAgsk/1pQpR4/OLn19mjxXrJ6/qPMj7HmP3cdJmTC+cr0QBAwQBAAAAAQVyY6ggeWnsD8uLZI394ksdCuJFaNOY3MOoO4CoUPlzI4zf09mIIQLnqyU3tdSelwMJquBunknzbOHJ/rvUTsjg0cygtPnDGaxnA0ANA7F1IQNdSezNVNAJnkNnYnfHptRiXWEdqIpd9Jv5UXp3kad3paxoAAA=' };

execSync('node connect/build.mjs', { stdio: 'ignore' });
const html = readFileSync('connect/dist/index.html', 'utf8');
const headers = existsSync('connect/dist/_headers') ? readFileSync('connect/dist/_headers', 'utf8') : '';

// ── hardening ──
ok('connect: CSP connect-src none (page + headers)', /connect-src 'none'/.test(html) && /connect-src 'none'/.test(headers));
ok('connect: script-src is hash-based, no unsafe-inline', /script-src[^;]*'sha256-/.test(html) && !/script-src[^;]*unsafe-inline/.test(html));
ok('connect: not framable (frame-ancestors none in headers)', /frame-ancestors 'none'/.test(headers));
ok('connect: no runtime network primitives (XHR/WebSocket/fetch/sendBeacon)',
   !/XMLHttpRequest|new WebSocket|navigator\.sendBeacon|EventSource|fetch\(/.test(html));
ok('connect: origin allow-list pins olesia.io', /https:\/\/olesia\.io/.test(html) && /ALLOWED\.indexOf\(e\.origin\)/.test(html));

// ── provider pins the wallet origin ──
const provider = readFileSync('connect/olesia-provider.js', 'utf8');
ok('provider: exposes window.olesia { isOlesia }', /window\.olesia\s*=/.test(provider) && /isOlesia:\s*true/.test(provider));
ok('provider: only trusts the wallet origin app.olesia.io', /WALLET_ORIGIN = 'https:\/\/app\.olesia\.io'/.test(provider) && /e\.origin !== WALLET_ORIGIN/.test(provider));
ok('provider: uses a popup + postMessage, no crypto/key handling', /window\.open\(/.test(provider) && /postMessage/.test(provider) && !/privKey|secp256k1|deriveKey|signHtlc|openSeed/.test(provider));

// ── browser smoke test (jsdom): the bridge API works over the audited engine ──
{
  let JSDOM; try { ({ JSDOM } = await import('jsdom')); } catch { console.log('jsdom not installed — smoke test skipped'); }
  if (JSDOM) {
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://app.olesia.io/connect' });
    await new Promise((r) => setTimeout(r, 300));
    const C = dom.window.OLESIA_CONNECT;
    ok('bridge: window.OLESIA_CONNECT present with the two methods', C && typeof C.getAccount === 'function' && typeof C.sign === 'function' && typeof C.review === 'function');
    const acct = C.getAccount({ mnemonic: MN, network: 'testnet4' });
    ok('olesia_getAccount: returns a testnet4 address + tpub, no key material', /^tb1q/.test(acct.address) && /^tpub/.test(acct.xpub) && acct.network === 'testnet4' && !('privKey' in acct));
    ok('getAccount refuses mainnet (testnet-only)', (() => { try { C.getAccount({ mnemonic: MN, network: 'mainnet' }); return false; } catch { return true; } })());
    const rv = C.review({ mnemonic: MN, network: 'testnet4', params: [{ psbtBase64: WK_REDEEM.psbt, network: 'testnet4', describe: { secret: WK_REDEEM.secret } }] });
    ok('review: redeem is mine + safe to sign (secret present)', rv.branch === 'redeem' && rv.mine === true && rv.safeToSign === true && rv.amount === 40000);
    const s = C.sign({ mnemonic: MN, network: 'testnet4', params: [{ psbtBase64: WK_REDEEM.psbt, network: 'testnet4', describe: { secret: WK_REDEEM.secret } }] });
    ok('olesia_signPsbt: returns signedTxHex reproducing the intent txid', s.txid === WK_REDEEM.txid && /^0200/.test(s.signedTxHex));
    ok('review: without the secret, redeem is NOT safe to sign', C.review({ mnemonic: MN, network: 'testnet4', params: [{ psbtBase64: WK_REDEEM.psbt, network: 'testnet4' }] }).safeToSign === false);
    dom.window.close();
  }
}

console.log(bad ? '\nCONNECT TEST FAILED' : '\nCONNECT TEST PASS — hardened bridge, engine-backed getAccount/sign, origin-pinned provider');
process.exit(bad ? 1 : 0);
