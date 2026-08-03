import { readFileSync, writeFileSync } from 'fs';
const bundle = readFileSync('dist/alea.bundle.js','utf8');
const ui = readFileSync('src/ui.js','utf8');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alea — a 2014-style Bitcoin wallet, done right</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#0e1116;color:#e6edf3}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:30px;margin:0 0 2px;letter-spacing:.5px}
h1 span{color:#f0a020}
.sub{color:#9aa7b4;margin:0 0 18px}
.badge{display:inline-block;padding:4px 10px;border-radius:6px;font-size:13px;margin:3px 6px 3px 0}
.ok{background:#10331d;color:#7ee2a8;border:1px solid #1c5c34}
.bad{background:#3a1416;color:#ff9ca0;border:1px solid #7a2327}
.card{background:#161b22;border:1px solid #2b333c;border-radius:10px;padding:18px;margin:14px 0}
label{display:block;font-weight:600;margin:0 0 6px}
.hint{color:#9aa7b4;font-size:13px;margin:2px 0 10px}
input,select{width:100%;padding:9px 11px;background:#0e1116;border:1px solid #2b333c;border-radius:7px;color:#e6edf3;font:inherit;margin-bottom:8px}
#pad{height:120px;border:1px dashed #3a444e;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#7d8794;cursor:crosshair;user-select:none;touch-action:none}
.bar{height:6px;background:#0e1116;border:1px solid #2b333c;border-radius:4px;margin-top:8px;overflow:hidden}
.bar>div{height:100%;width:0;background:#f0a020;transition:width .1s}
button{background:#f0a020;color:#111;border:0;border-radius:8px;padding:12px 18px;font-weight:700;font-size:16px;cursor:pointer;width:100%;margin-top:8px}
button:disabled{background:#5a4a24;color:#998;cursor:not-allowed}
button.sec{background:#2b333c;color:#e6edf3;font-size:14px;padding:9px}
#out{display:none}
#rwords{font-family:ui-monospace,Menlo,monospace;font-size:15px;background:#0e1116;border:1px solid #2b333c;border-radius:8px;padding:12px;word-spacing:4px;line-height:1.9}
#raddr{font-family:ui-monospace,monospace;word-break:break-all;color:#7ee2a8}
#words{font-family:ui-monospace,Menlo,monospace;font-size:16px;background:#0e1116;border:1px solid #2b333c;border-radius:8px;padding:14px;word-spacing:4px;line-height:2}
#addr{font-family:ui-monospace,monospace;word-break:break-all;color:#7ee2a8}
.warn{background:#2a1e08;border:1px solid #6b4e12;color:#f0cd8a;border-radius:8px;padding:14px;font-size:14px;margin:14px 0}
.warn b{color:#ffd57a}
.danger{background:#3a1416;border:1px solid #7a2327;color:#ff9ca0;border-radius:8px;padding:10px;font-size:13px;display:none}
code{background:#0e1116;padding:1px 5px;border-radius:4px}
.row{display:flex;gap:10px}.row>div{flex:1}
@media print{
  body{background:#fff;color:#000}
  .no-print{display:none!important}
  #out{display:block!important;background:#fff;border:1px solid #000}
  #words,#addr,#meta{background:#fff!important;color:#000!important;border-color:#000!important}
}
</style></head>
<body><div class="wrap">
<h1>Alea<span>.</span></h1>
<p class="sub no-print">A 2014-style instant wallet — the frictionless idea, rebuilt on entropy you can trust.</p>
<div class="no-print"><span id="selfcheck" class="badge">checking…</span><span id="offline" class="badge">…</span></div>

<div class="warn no-print">
<b>Read me first.</b> This is a learning tool and it is <b>unaudited</b>. It defaults to <b>testnet</b>
(free, worthless coins) on purpose. For anything real: download this file, <b>disconnect from the
internet</b>, and open it offline — and get the code independently reviewed before trusting it with
money you would miss.
</div>

<div class="card no-print">
<label>Network</label>
<select id="net"><option value="testnet" selected>Testnet (recommended for testing)</option><option value="mainnet">Mainnet (real bitcoin)</option></select>
<div id="netwarn" class="danger">⚠ Mainnet selected — this creates a wallet for <b>real bitcoin</b>. Generate offline, and do not fund it beyond what you can afford to lose until this code has been independently reviewed.</div>
</div>

<div class="card no-print">
<label>1 · Entropy root <span style="color:#7ee2a8;font-weight:400">— automatic</span></label>
<p class="hint">256 bits are drawn from your operating system's cryptographic RNG (<code>crypto.getRandomValues</code>) the moment you press Generate. <b>This is the real security.</b> Everything below is optional defence-in-depth, folded in by hashing — it can only help, never hurt.</p>
</div>

<div class="card no-print">
<label>2 · Mouse motion <span style="color:#9aa7b4;font-weight:400">— optional</span></label>
<p class="hint">Wiggle (or drag on touch) inside the box to stir in extra entropy.</p>
<div id="pad">— wiggle here —</div><div class="bar"><div id="mousebar"></div></div>
</div>

<div class="card no-print">
<label>3 · Dice rolls <span style="color:#9aa7b4;font-weight:400">— optional</span></label>
<p class="hint">Type physical dice rolls (e.g. <code>4 2 6 1 3 5 …</code>). Verifiable, offline, unbackdoorable.</p>
<input id="dice" placeholder="4 2 6 1 3 5 2 6 …">
</div>

<div class="card no-print">
<label>4 · Passphrase <span style="color:#9aa7b4;font-weight:400">— optional (BIP-39 &quot;25th word&quot;)</span></label>
<p class="hint">A secret applied on top of the 24 words. If set, you need <b>both</b> to restore. <b>Lose it or mistype it and the funds are gone — there is no recovery.</b> Type it twice.</p>
<div class="row"><div><input id="pass" placeholder="passphrase (blank if unsure)"></div><div><input id="pass2" placeholder="confirm passphrase"></div></div>
<div id="passwarn" class="danger">Passphrases do not match.</div>
</div>

<button id="gen" class="no-print">Generate wallet</button>

<div id="out" class="card">
<label>Your 24-word recovery phrase</label>
<p class="hint">Write these down <b>on paper</b>, in order. Anyone with these words (plus the passphrase, if set) controls the funds. Never photograph them, cloud-sync them, or type them into any website.</p>
<div id="words"></div>
<label style="margin-top:16px">First receive address</label>
<div id="addr"></div>
<p id="meta" class="hint" style="margin-top:8px"></p>

<div class="no-print" style="margin-top:18px;border-top:1px solid #2b333c;padding-top:14px">
<label>Verify your backup</label>
<p class="hint">From your <b>paper copy</b> (not the screen), type these two words to confirm you recorded them correctly.</p>
<div class="row">
<div><p class="hint" id="vq1">word #—</p><input id="va1" autocomplete="off"></div>
<div><p class="hint" id="vq2">word #—</p><input id="va2" autocomplete="off"></div>
</div>
<button id="vcheck" class="sec">Check my backup</button>
<div style="margin-top:8px"><span id="vresult"></span></div>
<button id="wipe" class="sec" style="margin-top:14px">Wipe screen</button>
</div>

<div class="no-print" style="margin-top:18px;border-top:1px solid #2b333c;padding-top:14px">
<label>Save to your computer</label>
<p class="hint"><b>Not a <code>wallet.dat</code></b> — that is Bitcoin Core's internal Berkeley DB format, which Core itself is retiring, and a fake one would be a dangerous illusion of a backup. These are the modern equivalents, and they actually restore.</p>
<p class="hint"><b>Encrypted backup (.json)</b> — your 24 words, encrypted with a password of your choosing (scrypt N=2^16 + XChaCha20-Poly1305). Your BIP-39 passphrase is deliberately <b>not</b> stored in it.</p>
<div class="row"><div><input id="fpass" type="password" placeholder="file password"></div><div><input id="fpass2" type="password" placeholder="confirm file password"></div></div>
<div id="fpwarn" class="danger">File passwords do not match.</div>
<button id="savebk" class="sec" disabled>Download encrypted backup</button>
<p class="hint" style="margin-top:14px"><b>Watch-only descriptor (.txt)</b> — import into Bitcoin Core or Sparrow to watch the balance. Contains <b>no</b> private key, so it is safe to keep on a normal machine.</p>
<div id="dr" class="hint" style="font-family:ui-monospace,monospace;word-break:break-all;color:#7ee2a8"></div>
<button id="savedesc" class="sec">Download watch-only descriptor</button>
<div style="margin-top:8px"><span id="saveinfo"></span></div>
</div>
</div>

<div class="card no-print">
<label>Restore from an encrypted backup</label>
<p class="hint">Test this now, while you still have the words on screen — an untested backup is not a backup.</p>
<input id="bkfile" type="file" accept="application/json,.json">
<div class="row"><div><input id="rpass" type="password" placeholder="file password"></div><div><input id="rbip39" placeholder="BIP-39 passphrase (if any)"></div></div>
<button id="restore" class="sec">Restore &amp; verify</button>
<div style="margin-top:8px"><span id="rinfo"></span></div>
<div id="rout" style="display:none;margin-top:12px">
<label>Recovered phrase</label><div id="rwords"></div>
<label style="margin-top:10px">Derived address</label><div id="raddr"></div>
</div>
</div>


<p class="sub no-print" style="margin-top:24px;font-size:13px">Built on audited primitives: <code>@scure/bip39</code>, <code>@scure/bip32</code>, <code>@noble/hashes</code>, <code>@noble/curves</code>, <code>@scure/base</code>. Derivation self-verified against the official BIP-84 test vector on load. No network calls, no storage, no URL secrets — works fully offline.</p>
</div>
<script>${bundle}</script>
<script>${ui}</script>
</body></html>`;
writeFileSync('index.html', html);
console.log('index.html bytes:', html.length);
