import { readFileSync, writeFileSync } from 'fs';
const bundle = readFileSync('web/dist/online.bundle.js', 'utf8');
const ui = readFileSync('web/ui.js', 'utf8');
const icon = 'data:image/png;base64,' + readFileSync('web/olesia-icon.png').toString('base64');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; manifest-src 'self'; connect-src https://mempool.space https://blockstream.info https://api.olesia.io; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>Olesia — Bitcoin Wallet</title>
<meta name="theme-color" content="#0b0e12">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Olesia">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="${icon}">
<link rel="icon" href="${icon}">
<style>
:root{
  --bg:#0b0e12; --panel:#0e1116; --surface:#161b22; --line:#2b333c; --line-soft:#222933;
  --text:#e6edf3; --muted:#9aa7b4; --faint:#6b7480;
  --accent:#f0a020; --accent-ink:#1a1205; --mint:#7ee2a8; --bad:#ff9ca0; --info:#5aa9e6; --violet:#b79cff;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  color-scheme:dark;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;color:var(--text);
  background:radial-gradient(900px 500px at 15% -10%,#16202c 0%,transparent 55%),radial-gradient(700px 450px at 100% 0%,#1c1508 0%,transparent 45%),var(--bg);
  -webkit-font-smoothing:antialiased}
#shell{max-width:560px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column}
header{display:flex;align-items:center;justify-content:space-between;padding:calc(12px + env(safe-area-inset-top)) 18px 10px}
.logo{display:flex;align-items:center;gap:9px;font-weight:800;font-size:17px;letter-spacing:-.01em}
.dot{width:26px;height:26px;border-radius:8px;background:var(--surface);border:1px solid var(--line);position:relative}
.dot::before{content:"";position:absolute;left:5px;top:4px;width:11px;height:14px;border:2.4px solid var(--text);border-radius:50%}
.dot::after{content:"";position:absolute;right:4px;bottom:4px;width:5px;height:5px;border-radius:50%;background:var(--accent)}
.hbtns{display:flex;gap:8px;align-items:center}
.netchip{display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--text)}
.netchip .sw{width:8px;height:8px;border-radius:50%;background:var(--violet)}
.netchip.main .sw{background:var(--bad)}
#lockbtn{display:none;background:var(--surface);border:1px solid var(--line);border-radius:999px;width:32px;height:32px;color:var(--muted);cursor:pointer;font-size:14px;padding:0}
main{flex:1;padding:2px 16px 96px;overflow-x:hidden}
.pane{display:none;animation:fade .22s ease}
.pane.on{display:block}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.pane{animation:none}}
h2{font-size:22px;letter-spacing:-.01em;margin:6px 0 4px}
.sub{color:var(--muted);font-size:13px;margin:0 0 12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px;margin:0 0 10px}
label{display:block;font-weight:600;margin:8px 0 6px;font-size:14px}
.hint{color:var(--muted);font-size:12.5px;margin:4px 0}
.mono{font-family:var(--mono);word-break:break-all;font-size:13px}
input,select,textarea{width:100%;padding:11px 12px;background:var(--panel);border:1px solid var(--line);border-radius:10px;color:var(--text);font-family:inherit;font-size:16px;margin-bottom:6px}
textarea{resize:vertical;min-height:64px;font-family:var(--mono)}
button{background:var(--accent);color:var(--accent-ink);border:0;border-radius:11px;padding:11px 16px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;min-height:42px}
button.sec{background:var(--surface);border:1px solid var(--line);color:var(--text);font-weight:600}
button.sec:hover{border-color:var(--accent)}
button:disabled{opacity:.45;cursor:default}
.ok{color:var(--mint)}.bad{color:var(--bad)}
.field{display:flex;gap:8px;align-items:stretch}.field input{flex:1;margin-bottom:0}
.copy,.paste{font-size:12px;padding:6px 12px;min-height:0}
.row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}
.warn{background:#2a1e08;border:1px solid #6b4e12;color:#f0cd8a;border-radius:11px;padding:11px 13px;font-size:13px;margin:10px 0}
.practice{display:inline-flex;align-items:center;gap:6px;color:var(--info);background:#0f2231;border:1px solid #1d4763;border-radius:999px;padding:4px 10px;font-size:11.5px;font-weight:600}
.practice.main{color:var(--bad);background:#2a1012;border-color:#5c2126}
.help{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;background:var(--line);color:var(--text);font-size:11px;font-weight:700;cursor:pointer;margin-left:6px;user-select:none;vertical-align:middle}
.tiptext{display:none;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:7px 0;font-size:12.5px;color:var(--muted);line-height:1.55}
a{color:var(--mint)}
/* hero balance card (the one vivid element on Home) */
.hero{position:relative;overflow:hidden;background:linear-gradient(135deg,#f6b53f 0%,#ef9d1a 55%,#d97e0e 100%);border-radius:20px;padding:22px 20px 18px;margin:6px 0 22px;color:#1a1205;box-shadow:0 18px 40px -18px rgba(240,160,32,.45)}
.hero .wm{position:absolute;right:-26px;bottom:-34px;width:150px;height:150px;border:22px solid rgba(26,18,5,.10);border-radius:50%;pointer-events:none}
.hero .wm::after{content:"";position:absolute;right:-16px;bottom:16px;width:26px;height:26px;border-radius:50%;background:rgba(26,18,5,.16)}
.balrow{display:flex;align-items:center;font-size:11px;letter-spacing:.1em;font-weight:800;opacity:.75}
.eye{margin-left:auto;cursor:pointer;color:inherit;background:none;border:0;padding:2px;min-height:0;opacity:.75;font-size:15px}
.bal{font-size:36px;font-weight:800;letter-spacing:-.02em;margin:7px 0 2px;font-variant-numeric:tabular-nums}
.bal .u{font-size:17px;font-weight:700;margin-left:4px;opacity:.7}
.balsub{font-size:12px;font-weight:600;opacity:.65;margin-bottom:10px}
.hero .practice{background:rgba(26,18,5,.14);border:0;color:#1a1205;font-weight:700}
.hero .practice.main{background:#2a1012;color:#ffb4b8;border:0}
/* round quick actions */
.qa{display:flex;justify-content:space-around;margin:0 4px 22px}
.qa button{background:none;border:0;color:var(--muted);font-size:12px;font-weight:600;display:flex;flex-direction:column;align-items:center;gap:8px;min-height:0;padding:0}
.qa .ic{width:58px;height:58px;border-radius:50%;background:var(--surface);border:1px solid var(--line);display:grid;place-items:center;font-size:21px;line-height:1;color:var(--text);transition:border-color .15s,transform .1s}
.qa button:hover .ic{border-color:var(--accent)}
.qa button:active .ic{transform:scale(.94)}
.sect{display:flex;align-items:center;justify-content:space-between;margin:14px 2px 8px}
.sect h3{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0;font-weight:700}
.sect a{font-size:12.5px;font-weight:600;text-decoration:none;color:var(--accent);cursor:pointer}
/* account rows */
.acct{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:12px 13px;margin-bottom:8px;cursor:pointer}
.acct:hover{border-color:var(--accent)}
.acct .badge{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font-family:var(--mono);font-size:11.5px;font-weight:700;flex:0 0 auto}
.b-p2wpkh{background:#10241c;color:var(--mint);border:1px solid #1c5c3a}
.b-p2tr{background:#1a1530;color:var(--violet);border:1px solid #3a2f66}
.b-p2sh-p2wpkh{background:#1c1608;color:var(--accent);border:1px solid #5a4212}
.b-p2pkh{background:#151b24;color:#9db4d0;border:1px solid #2f4661}
.b-p2pk{background:#241016;color:var(--bad);border:1px solid #5c2126}
.acct .meta{min-width:0;flex:1}
.acct .name{font-weight:700;font-size:14px;display:flex;align-items:center;gap:6px}
.acct .d{font-size:11.5px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acct .amt{text-align:right;font-variant-numeric:tabular-nums;flex:0 0 auto}
.acct .amt b{font-size:13.5px}.acct .amt span{display:block;font-size:10.5px;color:var(--faint)}
.tag{font-size:9px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;padding:2px 6px;border-radius:6px;background:#241016;color:var(--bad);border:1px solid #5c2126}
/* tx rows */
.tx{display:flex;align-items:center;gap:11px;padding:10px 2px;border-bottom:1px solid var(--line-soft);font-size:13px}
.tx .ti{width:34px;height:34px;border-radius:50%;background:var(--panel);border:1px solid var(--line);display:grid;place-items:center;font-size:14px;flex:0 0 auto}
.tx:last-child{border-bottom:0}
.tx a{text-decoration:none;font-size:12px}
.tx .v{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:700}
/* learn */
.prog{height:5px;background:var(--panel);border-radius:3px;overflow:hidden;margin:10px 0 4px}
.prog i{display:block;height:100%;width:0%;background:linear-gradient(90deg,var(--accent),var(--mint));transition:width .3s}
.lesson{background:var(--surface);border:1px solid var(--line);border-radius:13px;margin-bottom:8px;overflow:hidden}
.lesson>button{width:100%;background:none;border:0;color:var(--text);display:flex;align-items:center;gap:10px;padding:13px 14px;text-align:left;font-size:14px;font-weight:700;min-height:0}
.lesson .n{font-family:var(--mono);font-size:11px;color:var(--accent);font-weight:700}
.lesson .chk{margin-left:auto;color:var(--faint);font-size:12px}
.lesson .body{display:none;padding:0 14px 13px;color:var(--muted);font-size:13.5px;line-height:1.6}
.lesson .body b{color:var(--text)}
.lesson.open .body{display:block}
/* settings */
.srow{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--line);border-bottom-width:0;padding:13px 14px;cursor:pointer;font-size:14px}
.sgroup .srow:first-child{border-radius:13px 13px 0 0}
.sgroup .srow:last-child{border-radius:0 0 13px 13px;border-bottom-width:1px}
.sgroup .srow:only-child{border-radius:13px}
.srow .t{flex:1}.srow .t b{font-weight:600;display:block}.srow .t span{font-size:11.5px;color:var(--faint)}
.srow .val{font-size:12.5px;color:var(--muted);font-family:var(--mono)}
.slbl{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:700;margin:16px 2px 8px}
.sbody{display:none;background:var(--panel);border:1px solid var(--line);border-top:0;padding:13px 14px;border-radius:0 0 13px 13px;margin-top:-1px}
.sbody.on{display:block}
/* nav */
nav{position:fixed;bottom:0;left:0;right:0;display:flex;justify-content:center;background:color-mix(in srgb,var(--panel) 92%,transparent);backdrop-filter:blur(12px);border-top:1px solid var(--line);z-index:40}
.navin{display:flex;width:100%;max-width:560px;padding:8px 6px calc(8px + env(safe-area-inset-bottom))}
nav button{flex:1;background:none;border:0;color:var(--faint);font-size:10.5px;font-weight:600;display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 0;min-height:0}
nav button .ic{font-size:19px;line-height:1.15}
nav button.on{color:var(--accent)}
/* unlock overlay */
#unlock{position:fixed;inset:0;z-index:60;background:linear-gradient(180deg,#0b0e12,#0e1116);display:none;align-items:center;justify-content:center;padding:24px}
#unlock.on{display:flex}
.ucore{width:100%;max-width:330px;display:flex;flex-direction:column;align-items:center;text-align:center}
.ucore .dot{width:52px;height:52px;border-radius:15px}
.ucore .dot::before{left:11px;top:9px;width:20px;height:26px;border-width:4px}
.ucore .dot::after{right:9px;bottom:9px;width:9px;height:9px}
/* keypad */
.pindots{display:flex;gap:12px;margin:18px 0 6px;justify-content:center;min-height:14px}
.pindots i{width:13px;height:13px;border-radius:50%;border:1.5px solid var(--line)}
.pindots i.fill{background:var(--accent);border-color:var(--accent)}
.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%;max-width:280px;margin:14px auto 0}
.pad button{background:var(--surface);border:1px solid var(--line);color:var(--text);border-radius:50%;aspect-ratio:1;font-size:22px;font-weight:600;min-height:0;padding:0}
.pad button:active{border-color:var(--accent)}
.pad button.ghost{background:none;border:0;font-size:17px;color:var(--muted)}
/* confirm sheet */
#confirm{position:fixed;inset:0;z-index:70;background:rgba(5,7,10,.72);display:none;align-items:flex-end;justify-content:center}
#confirm.on{display:flex}
.sheet{width:100%;max-width:560px;background:var(--panel);border:1px solid var(--line);border-bottom:0;border-radius:20px 20px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom))}
.sheet h3{margin:0 0 4px;font-size:18px}
.sheet .crow{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid var(--line-soft);font-size:13.5px}
.sheet .crow:last-of-type{border-bottom:0}
.sheet .crow .k{color:var(--muted);flex:0 0 auto}
.sheet .crow .v{text-align:right;word-break:break-all;font-variant-numeric:tabular-nums}
.sheet .crow .v small{display:block;color:var(--faint);font-size:11.5px}
/* seed backup grid */
.seedgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0}
.seedgrid span{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-family:var(--mono);font-size:12.5px}
.seedgrid span i{color:var(--faint);font-style:normal;margin-right:7px;font-size:10.5px}
/* toast */
#toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom));max-width:min(92vw,520px);background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:10px 15px;font-size:13px;z-index:50;display:none;box-shadow:0 12px 30px -12px #000}
#toast.ok{border-color:#1c5c3a;color:var(--mint)}
#toast.bad{border-color:#5c2126;color:var(--bad)}
.back{background:none;border:0;color:var(--accent);font-weight:700;font-size:13.5px;padding:6px 0;min-height:0;margin-bottom:2px}
.feeps{display:flex;gap:8px;margin:2px 0 8px}
.feep{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:9px;padding:9px 4px;font-weight:600;font-size:12.5px;min-height:0}
.feep.active{background:#243447;border-color:#4a7fb5;color:#cfe6ff}
.orcard{cursor:pointer}
#orbody{display:none;margin-top:9px;font-size:12.5px;color:var(--muted);line-height:1.55;border-top:1px solid var(--line-soft);padding-top:9px}
#orbody b{color:var(--text)}
#result,#agresult,#p2pk_result{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px;margin-top:10px;display:none}
img.qr{display:none;margin:8px 0;border-radius:10px;max-width:200px}
@media(min-width:600px){main{padding-top:8px}}
</style></head>
<body>

<div id="unlock">
  <div class="ucore">
    <span class="dot"></span>
    <h2 style="margin:14px 0 2px">Enter your PIN</h2>
    <p class="hint" style="max-width:28ch">Your wallet is stored <b>encrypted</b> on this device — the PIN decrypts it in memory.</p>
    <div class="pindots" id="pindots"></div>
    <span id="vmsg" class="hint"></span>
    <div class="pad" id="pad">
      <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button>
      <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button>
      <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button>
      <button class="ghost" id="pad_abc" title="passphrase">abc</button><button data-k="0">0</button><button class="ghost" data-k="back">⌫</button>
    </div>
    <div class="field" style="width:100%;margin:12px 0 0;display:none" id="vpinrow"><input id="vpin" type="password" placeholder="passphrase" autocomplete="off"></div>
    <button id="vunlock" style="width:100%;max-width:280px;margin-top:16px">Unlock</button>
    <button id="vforget" class="sec" style="font-size:12px;margin-top:12px">Forget saved wallet…</button>
    <p class="hint" style="font-size:11px;color:var(--faint);margin-top:14px">scrypt + XChaCha20-Poly1305 · the seed itself never touches disk</p>
  </div>
</div>

<div id="confirm">
  <div class="sheet">
    <h3 id="c_title">Confirm</h3>
    <p class="hint" id="c_net" style="margin:0 0 6px"></p>
    <div id="c_rows"></div>
    <div class="row" style="margin-top:14px">
      <button class="sec" id="c_cancel">Cancel</button>
      <button id="c_go">Confirm & send</button>
    </div>
  </div>
</div>

<div id="shell">
<header>
  <span class="logo"><span class="dot"></span> Olesia</span>
  <span class="hbtns">
    <button id="lockbtn" title="Lock wallet">🔒</button>
    <span class="netchip" id="netchip"><span class="sw"></span><span id="netname">testnet4</span></span>
  </span>
</header>
<main>

<!-- ============ WELCOME ============ -->
<section class="pane" id="pane-welcome">
  <h2>Learn Bitcoin by doing<span style="color:var(--accent)">.</span></h2>
  <p class="sub">A real wallet on practice networks where mistakes cost nothing — every address type, free coins, and plain-English explainers as you go. <a href="https://olesia.io/learn/" target="_blank" rel="noopener">Start with the basics →</a></p>
  <div class="card">
    <label>Network <span class="help" data-target="tip_net">?</span></label>
    <div class="tiptext" id="tip_net">Bitcoin has several chains sharing the same rules. <b>Testnet3/4</b> and <b>Signet</b> use free, worthless coins for practice. <b>Mainnet</b> is real money — this wallet allows it for small amounts, but learn on a testnet first.</div>
    <select id="net"></select>
    <div id="mainwarn" class="warn" style="display:none"></div>
    <label>Your seed <span class="help" data-target="tip_seed">?</span><span class="hint" style="display:inline"> — 12/24 words, or an xpub for watch-only</span></label>
    <div class="tiptext" id="tip_seed">Your wallet <i>is</i> these words (BIP-39). Anyone with them controls the coins — there is no reset. Write them on paper, in order; never screenshot them. An <b>xpub</b> can watch a balance but cannot spend.</div>
    <textarea id="mnemonic" placeholder="word1 word2 … word24   —or—   xpub…/tpub…" autocomplete="off" spellcheck="false"></textarea>
    <div class="row">
      <button type="button" class="sec paste" data-paste="mnemonic">Paste</button>
      <button id="gen" class="sec">Generate new</button>
      <button id="load">Open wallet</button>
    </div>
  </div>
  <div class="card">
    <b style="font-size:14px">New here? Three steps 👋</b>
    <ol class="hint" style="margin:8px 0 0;padding-left:20px;line-height:1.8;font-size:13px">
    <li>Tap <b>Generate new</b>, then <b>Open wallet</b>. Write the words on paper.</li>
    <li><b>Receive:</b> copy your address, get free coins from the <a href="https://olesia.io/faucet/" target="_blank" rel="noopener">faucet</a>.</li>
    <li><b>Send</b> anywhere — then explore every address type in Accounts.</li>
    </ol>
  </div>
  <p class="hint" style="text-align:center">Non-custodial · open source · <a href="https://github.com/testnetbtc/BTC_Wallet" target="_blank" rel="noopener">verify everything</a></p>
</section>

<!-- ============ HOME ============ -->
<section class="pane" id="pane-home">
  <div class="hero">
    <span class="wm"></span>
    <div class="balrow">TOTAL BALANCE <button class="eye" id="bal_eye" title="hide">👁</button></div>
    <div class="bal" id="bal_total">—<span class="u" id="bal_unit">tBTC</span></div>
    <div class="balsub" id="bal_sub"></div>
    <span class="practice" id="chip_net"></span>
  </div>
  <div class="qa">
    <button id="qa_send"><span class="ic">↗</span>Send</button>
    <button id="qa_recv"><span class="ic">↙</span>Receive</button>
    <button id="qa_faucet"><span class="ic">🚰</span>Faucet</button>
    <button id="qa_learn"><span class="ic">🎓</span>Learn</button>
  </div>
  <div class="sect" style="margin-top:0"><h3>History</h3><a id="home_refresh">Refresh</a></div>
  <div class="card" id="home_activity" style="padding:4px 14px"><div class="hint" style="padding:8px 0">—</div></div>
</section>

<!-- ============ ACCOUNTS ============ -->
<section class="pane" id="pane-accounts">
  <h2>Accounts</h2>
  <p class="sub">One seed → every Bitcoin address type. Tap any to receive, send, or learn what makes it different.</p>
  <div id="acct_watchnote" class="warn" style="display:none">Watch-only (xpub): the SegWit account is visible; other types need the seed. Spending happens via the air-gap tools in Settings.</div>
  <div id="acct_list"></div>
</section>

<!-- ============ ACCOUNT DETAIL ============ -->
<section class="pane" id="pane-account">
  <button class="back" id="back_accounts">‹ Accounts</button>
  <h2 id="acc_title">Account</h2>
  <p class="sub" id="acc_about"></p>
  <div class="card">
    <label style="margin-top:0">Receive address</label>
    <div class="mono" id="acc_addr" style="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px"></div>
    <img id="acc_qr" class="qr" alt="address QR">
    <div class="row" style="margin-top:8px">
      <button type="button" class="sec copy" data-copy="acc_addr">Copy address</button>
      <button type="button" class="sec" id="acc_sendbtn">Send from this account</button>
    </div>
    <p class="hint" id="acc_recvhint">Send coins here, then Refresh. Need some? <a href="https://olesia.io/faucet/" target="_blank" rel="noopener">Get free testnet coins →</a></p>
    <label>Label <span class="hint" style="display:inline">(saved in this browser only)</span></label>
    <input id="acc_label" placeholder="e.g. practice account" autocomplete="off">
  </div>
  <div class="card">
    <div class="sect" style="margin-top:0"><h3>Balance</h3><a id="acc_refresh">Refresh</a></div>
    <div class="mono" id="acc_bal">—</div>
    <div class="hint" id="acc_utxos"></div>
    <label style="margin-top:12px">Recent transactions</label>
    <div id="acc_hist" class="hint">—</div>
  </div>

  <!-- P2PK lab -->
  <div id="lab" style="display:none">
  <div class="card">
    <label style="margin-top:0">🧪 P2PK Lab <span class="help" data-target="tip_lab">?</span></label>
    <div class="tiptext" id="tip_lab">P2PK has <b>no address</b>, so no ordinary wallet can pay it and explorers can't show its balance. The trick: fund your <b>SegWit</b> account first, then move coins into P2PK here — Olesia builds the raw <code>&lt;pubkey&gt; OP_CHECKSIG</code> output itself and remembers the exact coin it created.</div>
    <div class="warn" id="p2pk_need" style="display:none">Fund your <b>SegWit</b> account first (it pays for the move) — there's a faucet link on its page.</div>
    <label>Move into P2PK (sats)</label>
    <div class="field"><input id="p2pk_amt" placeholder="e.g. 20000" inputmode="numeric"><button id="p2pk_fundbtn">Fund P2PK</button></div>
    <p class="hint" id="p2pk_srcbal">—</p>
    <label style="margin-top:10px">Your P2PK coins <span class="hint" style="display:inline">(tracked in this browser)</span></label>
    <div id="p2pk_list" class="hint">—</div>
    <button type="button" id="p2pk_refresh" class="sec" style="margin-top:6px">Refresh</button>
    <label style="margin-top:12px">Recover a coin <span class="hint" style="display:inline">— paste the funding txid</span></label>
    <div class="field"><input id="p2pk_import" placeholder="txid  (or txid:vout)" autocomplete="off" spellcheck="false"><button type="button" id="p2pk_importbtn" class="sec">Add</button></div>
    <label style="margin-top:12px">Spend a P2PK coin out</label>
    <div class="field"><input id="p2pk_to" placeholder="destination address" autocomplete="off"><button type="button" class="sec paste" data-paste="p2pk_to">Paste</button></div>
    <div id="p2pk_result" class="mono"></div>
  </div>
  </div>
</section>

<!-- ============ SEND ============ -->
<section class="pane" id="pane-send">
  <button class="back" id="back_home">‹ Home</button>
  <h2>Send</h2>
  <p class="sub">From <b id="send_from" style="color:var(--text)">—</b> · <span id="send_bal">—</span></p>
  <div id="send_wo" class="warn" style="display:none">Watch-only: this wallet can't sign. Build an unsigned PSBT in <b>Settings → Air-gap tools</b>, sign it offline, broadcast it there.</div>
  <div id="send_p2pk" class="warn" style="display:none">P2PK spends from its own Lab — open the P2PK account and use <b>Spend a P2PK coin out</b>.</div>
  <div class="card">
    <label style="margin-top:0">To</label>
    <div class="field"><input id="to" placeholder="destination address" autocomplete="off" spellcheck="false"><button type="button" class="sec paste" data-paste="to">Paste</button></div>
    <label>Amount (sats) <span class="help" data-target="tip_send">?</span></label>
    <div class="tiptext" id="tip_send">A transaction spends your UTXOs (coins) as inputs and creates outputs: one to the recipient, and usually one back to you as <b>change</b>. Amounts are in satoshis — 100,000,000 sats = 1 BTC.</div>
    <div class="field"><input id="amt" placeholder="e.g. 10000" inputmode="numeric"><button type="button" class="sec" id="maxbtn">Max (sweep)</button></div>
    <p class="hint" id="sweepnote" style="display:none">Sweep mode: sends <b>everything minus the fee</b> in one transaction (no change). Type an amount to switch back.</p>
  </div>
  <div class="card orcard" id="ormore">
    <div style="display:flex;align-items:center;gap:8px">
      <b style="font-size:13px">Add a message · OP_RETURN</b>
      <span style="margin-left:auto;color:var(--accent);font-size:12px;font-weight:700" id="orchev">What's this? ▾</span>
    </div>
    <div id="orbody">
      A tiny <b>permanent note</b> (~80 bytes) written into Bitcoin's public record. It carries no coins and can never be spent.<br><br>
      <b>Genuine uses:</b> proving a document existed at a point in time, notarising, attribution, a personal message or memorial.<br><br>
      <b>The famous one:</b> Satoshi wrote a newspaper headline — <i>"The Times 03/Jan/2009 Chancellor on brink of second bailout for banks"</i> — into the very first block. OP_RETURN is today's tidy way to leave your own mark like that.<br><br>
      <b>Where we stand:</b> people disagree about what data belongs on Bitcoin. Olesia is neutral — it's part of the protocol, so it's here, explained, for you to use thoughtfully. <span style="color:var(--faint)">(No NFTs or inscriptions.)</span>
    </div>
    <input id="msg" placeholder="optional message (≤80 bytes)" autocomplete="off" style="margin-top:9px" onclick="event.stopPropagation()">
  </div>
  <div class="card">
    <label style="margin-top:0">Network fee <span class="help" data-target="tip_fee">?</span></label>
    <div class="tiptext" id="tip_fee">Miners include transactions that pay them, priced in <b>sat/vB</b>. <b>Auto</b> asks the network for a live estimate — the safe default. Higher = confirms faster.</div>
    <div class="feeps">
      <button type="button" class="feep active" data-fee="">✨ Auto</button>
      <button type="button" class="feep" data-fee="1">🐢 1</button>
      <button type="button" class="feep" data-fee="2">🚶 2</button>
      <button type="button" class="feep" data-fee="5">🚀 5</button>
    </div>
    <input id="fee" placeholder="custom sat/vB (Auto = network estimate)" inputmode="numeric">
  </div>
  <div class="row">
    <button id="dryrun" class="sec">Build (dry run)</button>
    <button id="send">Send</button>
  </div>
  <div id="result" class="mono"></div>
</section>

<!-- ============ LEARN ============ -->
<section class="pane" id="pane-learn">
  <h2>Learn Bitcoin</h2>
  <p class="sub">Every concept in plain English — then try it for real. Progress saves on this device.</p>
  <div class="prog"><i id="learn_bar"></i></div>
  <p class="hint" id="learn_progtext" style="margin-bottom:12px">0 of 9</p>
  <div id="lessons"></div>
  <p class="hint" style="margin-top:12px">Want the long version with diagrams? <a href="https://olesia.io/learn/" target="_blank" rel="noopener">olesia.io/learn →</a></p>
</section>

<!-- ============ SETTINGS ============ -->
<section class="pane" id="pane-settings">
  <h2>Settings</h2>
  <p class="slbl">Wallet</p>
  <div class="sgroup">
    <div class="srow"><span>🌐</span><span class="t"><b>Network</b></span><select id="set_net" style="width:auto;margin:0;padding:7px 10px;font-size:13px"></select></div>
    <div class="srow" id="set_xpub"><span>🔎</span><span class="t"><b>Account xpub (SegWit)</b><span>share balances without spend power</span></span><span class="val">›</span></div>
  </div>
  <div class="sbody" id="xpub_body"><div class="mono" id="set_xpub_out"></div><button type="button" class="sec copy" data-copy="set_xpub_out" style="margin-top:8px">Copy xpub</button></div>

  <p class="slbl">Security</p>
  <div class="sgroup">
    <div class="srow" id="set_vault"><span>🔒</span><span class="t"><b>Keep wallet on this device</b><span id="vault_state">not saved — seed lives in this tab only</span></span><span class="val">›</span></div>
    <div class="srow" id="set_backup"><span>📜</span><span class="t"><b>Backup seed phrase</b><span>view your words — PIN required</span></span><span class="val">›</span></div>
    <div class="srow" id="set_lock"><span>🚪</span><span class="t"><b>Lock now</b><span>clears the seed from memory</span></span></div>
  </div>
  <div class="sbody" id="backup_body">
    <div class="warn" style="margin-top:0">Anyone who sees these words <b>controls the coins</b>. Make sure nobody is watching your screen, and never screenshot them — write them on paper.</div>
    <div id="bk_gate">
      <div class="field" id="bk_pinrow" style="display:none"><input id="bk_pin" type="password" placeholder="enter your PIN" autocomplete="off"><button id="bk_reveal" class="sec">Reveal</button></div>
      <button id="bk_hold" class="sec" style="display:none;width:100%">Hold to reveal (1.5s)…</button>
    </div>
    <div id="bk_show" style="display:none">
      <div class="seedgrid" id="bk_words"></div>
      <button id="bk_hide" class="sec" style="width:100%">Hide</button>
    </div>
  </div>
  <div class="sbody" id="vault_body">
    <p class="hint" style="margin-top:0">Saves your seed <b>encrypted</b> (scrypt + XChaCha20-Poly1305 — the cold generator's own crypto). Plaintext never touches disk; your PIN decrypts it in memory. A weak PIN on a compromised device is still a risk — real money belongs in cold storage.</p>
    <div class="field"><input id="vsetpin" type="password" placeholder="choose a PIN / passphrase (4+ chars)" autocomplete="off"><button id="vsave" class="sec">Save</button></div>
    <button id="vforget2" class="sec" style="font-size:12px;margin-top:8px">Forget saved wallet…</button>
  </div>

  <p class="slbl">Advanced</p>
  <div class="sgroup">
    <div class="srow" id="set_airgap"><span>✈️</span><span class="t"><b>Air-gap / PSBT tools</b><span>the mainnet-safe path (SegWit account)</span></span><span class="val">›</span></div>
  </div>
  <div class="sbody" id="airgap_body">
    <p class="hint" style="margin-top:0">Watch-only online: <b>Build unsigned</b> (uses the Send screen's fields) → sign <b>offline</b> → <b>Broadcast</b> here. The seed never needs to be online.</p>
    <button id="buildunsigned" class="sec">Build unsigned PSBT (from Send fields)</button>
    <textarea id="unsignedout" placeholder="unsigned PSBT (base64)" readonly></textarea>
    <button type="button" class="sec copy" data-copy="unsignedout">Copy unsigned</button>
    <label style="margin-top:12px">Sign a PSBT <span class="hint" style="display:inline">(needs the seed — go offline for mainnet)</span></label>
    <textarea id="signin" placeholder="paste an unsigned PSBT (base64)" autocomplete="off" spellcheck="false"></textarea>
    <div class="row"><button type="button" class="sec paste" data-paste="signin">Paste</button><button id="signbtn" class="sec">Sign PSBT</button></div>
    <textarea id="signedout" placeholder="signed PSBT appears here" readonly style="margin-top:8px"></textarea>
    <button type="button" class="sec copy" data-copy="signedout">Copy signed</button>
    <label style="margin-top:12px">Broadcast a signed PSBT</label>
    <textarea id="bcin" placeholder="paste a signed PSBT (base64)" autocomplete="off" spellcheck="false"></textarea>
    <div class="row"><button type="button" class="sec paste" data-paste="bcin">Paste</button><button id="bcbtn">Broadcast</button></div>
    <div id="agresult" class="mono"></div>
  </div>

  <p class="slbl">About</p>
  <div class="sgroup">
    <div class="srow" onclick="window.open('https://olesia.io/#verify','_blank','noopener')"><span>✅</span><span class="t"><b>Verify this build</b><span>reproducible — check the hash yourself</span></span><span class="val">↗</span></div>
    <div class="srow" onclick="window.open('https://github.com/testnetbtc/BTC_Wallet','_blank','noopener')"><span>🐙</span><span class="t"><b>Source & audits</b><span>github.com/testnetbtc/BTC_Wallet</span></span><span class="val">↗</span></div>
    <div class="srow"><span>🏷️</span><span class="t"><b>Version</b></span><span class="val">2.1.0</span></div>
  </div>
  <p class="hint" style="margin-top:14px">Balances/broadcast via mempool.space (mainnet broadcast via api.olesia.io). No analytics, no server-side storage. Signing with <code>@scure/btc-signer</code>, in your browser.</p>
</section>

</main>
<nav><div class="navin">
  <button data-nav="home" class="on"><span class="ic">⌂</span>Home</button>
  <button data-nav="accounts"><span class="ic">▦</span>Accounts</button>
  <button data-nav="learn"><span class="ic">📖</span>Learn</button>
  <button data-nav="settings"><span class="ic">⚙</span>Settings</button>
</div></nav>
</div>

<div id="toast"></div>
<script>${bundle}</script>
<script>${ui}</script>
</body></html>`;
writeFileSync('web/index.html', html);
console.log('web/index.html bytes:', html.length);
