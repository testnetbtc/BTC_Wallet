// Build the Olesia faucet page (free practice coins for testnet4 / signet / testnet3).
//   cd /home/faucet/BTC_Wallet && node infra/faucet-page/build.mjs
// Output: infra/faucet-page/publish/  ->  Cloudflare Pages project "olesia-wallet" (app.olesia.io)
//   /            the "this wallet has moved" notice (unchanged)
//   /faucet/     this page
// The faucet page lives on a DIFFERENT origin from the wallet (olesia.io) on purpose: it has to
// run a third-party script (the Cloudflare Turnstile human check), and that must never share an
// origin with the page that handles keys. The wallet only LINKS here, with the address filled in.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { inlineScriptHashes, buildCSP, securityHeaders } from '../../tools/csp.mjs';

const API = 'https://faucet.olesia.io';
const TURNSTILE_SITEKEY = '0x4AAAAAAEMwWUd3W9ng0TAN';   // public site key (same one the old faucet page used)
const font = (f) => 'data:font/woff2;base64,' + readFileSync('packages/bitcoin/mainnet/fonts/' + f).toString('base64');
const fontRange = readFileSync('packages/bitcoin/mainnet/fonts/unicode-range.txt', 'utf8').trim();

const script = `
(function () {
  const API = ${JSON.stringify(API)}, SITEKEY = ${JSON.stringify(TURNSTILE_SITEKEY)};
  const $ = (s) => document.querySelector(s);
  const NETS = { testnet4: ['Testnet 4', 'tBTC', 'https://mempool.space/testnet4/tx/'], signet: ['Signet', 'sBTC', 'https://mempool.space/signet/tx/'], testnet3: ['Testnet 3', 'tBTC', 'https://mempool.space/testnet/tx/'] };
  // network + address arrive in the query string from the wallet; both are validated before use
  const q = new URLSearchParams(location.search);
  let net = Object.prototype.hasOwnProperty.call(NETS, q.get('network') || '') ? q.get('network') : 'testnet4';
  const qa = q.get('address') || '';
  if (/^[0-9A-Za-z]{26,90}$/.test(qa)) $('#addr').value = qa;
  function renderNets() {
    const box = $('#nets'); box.textContent = '';
    Object.keys(NETS).forEach((n) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = NETS[n][0]; if (n === net) b.className = 'on'; b.addEventListener('click', () => { net = n; renderNets(); }); box.appendChild(b); });
    $('#netname').textContent = NETS[net][0];
  }
  renderNets();
  const say = (cls, text) => { const o = $('#out'); o.className = 'out ' + cls; o.textContent = text; o.hidden = false; return o; };
  let token = '';
  window._olesiaTs = (t) => { token = t; };
  window._olesiaTsErr = (code) => { say('bad', 'The human check could not load (code ' + String(code).slice(0, 12) + '). Reload the page and try again.'); };
  const w = document.createElement('div'); w.className = 'cf-turnstile'; w.dataset.sitekey = SITEKEY; w.dataset.callback = '_olesiaTs'; w.dataset.errorCallback = '_olesiaTsErr'; w.dataset.theme = 'dark';
  $('#ts').appendChild(w);
  const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'; s.async = true; s.defer = true; document.head.appendChild(s);
  async function info() {
    try {
      const d = await (await fetch(API + '/info')).json();
      $('#drip').textContent = Number(d.drip).toLocaleString('en-US');
      $('#state').textContent = d.paused ? 'The faucet is paused right now.' : d.ledgerHealthy === false ? 'The faucet is not paying out right now.' : 'The faucet is online.';
    } catch { $('#state').textContent = 'The faucet is offline right now.'; }
  }
  info();
  $('#go').addEventListener('click', async () => {
    const address = $('#addr').value.trim(), btn = $('#go');
    if (!address) return say('bad', 'Enter your ' + NETS[net][0] + ' address first.');
    if (!token) return say('bad', 'Please complete the human check first.');
    btn.disabled = true; say('', 'Sending…');
    try {
      const r = await fetch(API + '/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: net, address, token }) });
      const d = await r.json();
      if (window.turnstile) { window.turnstile.reset(); token = ''; }   // a check is single-use
      if (!r.ok) say('bad', '✗ ' + String(d.error || 'the claim failed').slice(0, 200));
      else {
        const o = say('ok', '✓ Sent ' + Number(d.amount).toLocaleString('en-US') + ' sats on ' + NETS[net][0] + '. Go back to your Olesia wallet tab and press Refresh.');
        if (/^[0-9a-fA-F]{64}$/.test(String(d.txid || ''))) { o.appendChild(document.createElement('br')); const a = document.createElement('a'); a.href = NETS[net][2] + d.txid; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'view the transaction ↗'; o.appendChild(a); }
      }
    } catch { say('bad', '✗ Could not reach the faucet. Try again shortly.'); }
    btn.disabled = false;
  });
})();
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Olesia faucet — free practice coins</title>
<style>
@font-face{font-family:'IBM Plex Sans';font-style:normal;font-weight:100 700;font-display:swap;src:url(${font('IBMPlexSans-var-latin.woff2')}) format('woff2');unicode-range:${fontRange}}
@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:500;font-display:swap;src:url(${font('IBMPlexMono-500-latin.woff2')}) format('woff2');unicode-range:${fontRange}}
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 'IBM Plex Sans',-apple-system,"Segoe UI",system-ui,sans-serif;background:#171717;color:#f4f4f4}
main{max-width:560px;margin:0 auto;padding:22px 16px 60px}
.logo{font-weight:700;font-size:22px}.logo span{color:#ff6a00}
h1{font-size:21px;font-weight:600;margin:18px 0 4px}
p{color:#b3b3b3;font-size:13.5px;margin:4px 0 12px}
.card{background:#222;border:1px solid #3a3a3a;border-top:3px solid #a99bff;border-radius:8px;padding:16px;margin:14px 0}
label{display:block;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#b3b3b3;font-weight:600;margin:12px 0 6px}
input{width:100%;padding:11px 12px;background:#111;border:1px solid #3a3a3a;border-radius:8px;color:#f4f4f4;font:500 14px 'IBM Plex Mono',ui-monospace,monospace}
input:focus,button:focus-visible{outline:2px solid #ff8a33;outline-offset:1px}
.seg{display:flex;gap:8px}
.seg button{flex:1;min-height:44px;background:#111;border:1px solid #3a3a3a;border-radius:8px;color:#f4f4f4;font:600 13px inherit;font-family:inherit;cursor:pointer}
.seg button.on{background:#2b1a0c;border-color:#ff6a00;color:#ff8a33}
#go{width:100%;min-height:50px;margin-top:12px;background:#ff6a00;color:#171717;border:0;border-radius:8px;font:600 16px inherit;font-family:inherit;cursor:pointer}
#go:disabled{opacity:.45;cursor:default}
#ts{margin:14px 0 2px;min-height:65px}
.out{border-radius:8px;padding:11px 13px;font-size:13.5px;margin-top:12px;background:#111;border:1px solid #3a3a3a;color:#b3b3b3}
.out.ok{border-color:#2f7a4b;color:#62d98a}.out.bad{border-color:#6e2626;color:#ff8f8f}
a{color:#ff8a33}
.tag{display:inline-block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;padding:2px 7px;border-radius:4px;background:#2c2c2c;color:#cfcfcf;border:1px solid #3a3a3a;margin-left:6px;vertical-align:middle}
</style></head>
<body><main>
<div class="logo">Olesia<span>.</span></div>
<h1>Faucet <span class="tag">practice coins · no value</span></h1>
<p>Free coins for Bitcoin's practice networks, so you can try sending and receiving with nothing at stake. <span id="drip">100,000</span> sats per address per day. <span id="state"></span></p>
<div class="card">
<label>Network</label>
<div class="seg" id="nets"></div>
<label for="addr">Your <span id="netname">Testnet 4</span> address</label>
<input id="addr" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="tb1…">
<div id="ts"></div>
<button id="go" type="button">Send me test coins</button>
<div class="out" id="out" hidden></div>
</div>
<p>These coins are worthless by design: nobody legitimately sells them. Your practice address comes from your Olesia wallet's Faucet tab. This page never asks for your recovery words or password — the faucet only needs an address.</p>
<p><a href="https://olesia.io/">Back to olesia.io</a></p>
</main>
<script>${script}</script>
</body></html>`;

const out = 'infra/faucet-page/publish';
rmSync(out, { recursive: true, force: true });
mkdirSync(out + '/faucet', { recursive: true });
writeFileSync(out + '/faucet/index.html', html);
copyFileSync('infra/mothball/app/index.html', out + '/index.html');

const faucetCsp = buildCSP({ scriptHashes: inlineScriptHashes(html), scriptHosts: ['https://challenges.cloudflare.com'],
  connect: `${API} https://challenges.cloudflare.com`, img: 'data:', frame: 'https://challenges.cloudflare.com' });
const noticeCsp = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const base = Object.entries(securityHeaders(null)).filter(([k]) => k !== 'Cross-Origin-Opener-Policy' && k !== 'Cross-Origin-Resource-Policy').map(([k, v]) => `  ${k}: ${v}`).join('\n');
writeFileSync(out + '/_headers', `/*\n${base}\n  Cache-Control: no-store\n\n/\n  Content-Security-Policy: ${noticeCsp}\n\n/index.html\n  Content-Security-Policy: ${noticeCsp}\n\n/faucet/*\n  Content-Security-Policy: ${faucetCsp}\n`);
console.log('faucet page:', html.length, 'bytes ·', inlineScriptHashes(html).length, 'script hash');
console.log(faucetCsp);
