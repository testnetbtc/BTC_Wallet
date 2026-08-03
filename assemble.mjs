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
input,select,textarea{width:100%;padding:9px 11px;background:#0e1116;border:1px solid #2b333c;border-radius:7px;color:#e6edf3;font:inherit}
#pad{height:120px;border:1px dashed #3a444e;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#7d8794;cursor:crosshair;user-select:none}
.bar{height:6px;background:#0e1116;border:1px solid #2b333c;border-radius:4px;margin-top:8px;overflow:hidden}
.bar>div{height:100%;width:0;background:#f0a020;transition:width .1s}
button{background:#f0a020;color:#111;border:0;border-radius:8px;padding:12px 18px;font-weight:700;font-size:16px;cursor:pointer;width:100%;margin-top:8px}
#out{display:none}
#words{font-family:ui-monospace,Menlo,monospace;font-size:16px;background:#0e1116;border:1px solid #2b333c;border-radius:8px;padding:14px;word-spacing:4px;line-height:2}
#addr{font-family:ui-monospace,monospace;word-break:break-all;color:#7ee2a8}
.warn{background:#2a1e08;border:1px solid #6b4e12;color:#f0cd8a;border-radius:8px;padding:14px;font-size:14px}
.warn b{color:#ffd57a}
code{background:#0e1116;padding:1px 5px;border-radius:4px}
</style></head>
<body><div class="wrap">
<h1>Alea<span>.</span></h1>
<p class="sub">A 2014-style instant wallet — the frictionless idea, rebuilt on entropy you can trust.</p>
<div><span id="selfcheck" class="badge">checking…</span><span id="offline" class="badge">…</span></div>

<div class="warn" style="margin-top:14px">
<b>Read me first.</b> This is a learning tool. It defaults to <b>testnet</b> (free, worthless coins) on purpose.
Real security requires generating <b>offline</b> (disconnect first) and having the code independently reviewed
before you trust it with meaningful money. Treat it exactly the way this project taught you to treat any wallet:
prove it on testnet, and don't fund a mainnet address with more than you'd shrug off losing until it's been audited.
</div>

<div class="card">
<label>Network</label>
<select id="net"><option value="testnet" selected>Testnet (recommended for testing)</option><option value="mainnet">Mainnet (real bitcoin)</option></select>
</div>

<div class="card">
<label>1 · Entropy root <span style="color:#7ee2a8;font-weight:400">— automatic</span></label>
<p class="hint">256 bits are drawn from your operating system's cryptographic RNG (<code>crypto.getRandomValues</code>) the instant you press Generate. This is the real security. Everything below is optional defence-in-depth folded in by hashing — it can only help, never hurt.</p>
</div>

<div class="card">
<label>2 · Mouse motion <span style="color:#9aa7b4;font-weight:400">— optional</span></label>
<p class="hint">Wiggle inside the box to stir in extra entropy (this is theatre + insurance, not the foundation).</p>
<div id="pad">— wiggle here —</div><div class="bar"><div id="mousebar"></div></div>
</div>

<div class="card">
<label>3 · Dice rolls <span style="color:#9aa7b4;font-weight:400">— optional</span></label>
<p class="hint">Type physical dice rolls (e.g. <code>4 2 6 1 3 5 …</code>). Verifiable, offline, unbackdoorable — the paranoid's favourite source. Folded in by hashing.</p>
<input id="dice" placeholder="4 2 6 1 3 5 2 6 …">
</div>

<div class="card">
<label>4 · Passphrase <span style="color:#9aa7b4;font-weight:400">— optional (BIP-39 &quot;25th word&quot;)</span></label>
<p class="hint">A secret applied on top of the 24 words. If set, you need <b>both</b> the words and this passphrase to restore. Lose it and the funds are gone — there is no recovery.</p>
<input id="pass" type="text" placeholder="leave blank if unsure">
</div>

<button id="gen">Generate wallet</button>

<div id="out" class="card">
<label>Your 24-word recovery phrase</label>
<p class="hint">Write these down <b>on paper</b>, in order. Anyone with these words (and the passphrase, if set) controls the funds. Never type them into a website, photo, or cloud note.</p>
<div id="words"></div>
<label style="margin-top:16px">First receive address</label>
<div id="addr"></div>
<p id="meta" class="hint" style="margin-top:8px"></p>
</div>

<p class="sub" style="margin-top:24px;font-size:13px">Built on audited primitives: <code>@scure/bip39</code>, <code>@scure/bip32</code>, <code>@noble/hashes</code>, <code>@noble/curves</code>, <code>@scure/base</code>. Derivation self-verified against the official BIP-84 test vector on load. No network calls — this page works fully offline.</p>
</div>
<script>${bundle}</script>
<script>${ui}</script>
</body></html>`;
writeFileSync('index.html', html);
console.log('index.html bytes:', html.length);
