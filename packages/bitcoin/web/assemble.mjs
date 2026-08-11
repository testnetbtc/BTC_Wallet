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
.logo{font-weight:800;font-size:20px;letter-spacing:-.01em}
.ldot{color:var(--accent)}
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
.netlabel{text-align:center;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);font-weight:700;margin:10px 0 11px}
.netlabel .ldot{letter-spacing:0}
.netpills{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.netpill{display:inline-flex;align-items:center;gap:7px;background:var(--panel);border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:9px 15px;font-size:13.5px;font-weight:600;cursor:pointer;min-height:0}
.netpill .nd{width:8px;height:8px;border-radius:50%;background:var(--violet)}
.netpill[data-net="mainnet"] .nd{background:var(--bad)}
.netpill.on{border-color:var(--accent);color:var(--text);background:var(--surface)}
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
nav button .ic{display:inline-flex}
nav button .ic svg{width:21px;height:21px}
nav button.on{color:var(--accent)}
/* unlock overlay */
#unlock{position:fixed;inset:0;z-index:60;background:linear-gradient(180deg,#0b0e12,#0e1116);display:none;align-items:center;justify-content:center;padding:24px}
#unlock.on{display:flex}
.ucore{width:100%;max-width:330px;display:flex;flex-direction:column;align-items:center;text-align:center}
/* keypad */
.pindots{display:flex;gap:12px;margin:18px 0 6px;justify-content:center;min-height:14px}
.pindots i{width:13px;height:13px;border-radius:50%;border:1.5px solid var(--line)}
.pindots i.fill{background:var(--accent);border-color:var(--accent)}
.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%;max-width:280px;margin:14px auto 0}
.pad button{background:var(--surface);border:1px solid var(--line);color:var(--text);border-radius:50%;aspect-ratio:1;font-size:22px;font-weight:600;min-height:0;padding:0}
.pad button:active{border-color:var(--accent)}
.pad button.ghost{background:none;border:0;font-size:17px;color:var(--muted)}
/* confirm sheet */
#confirm,#pinsheet{position:fixed;inset:0;z-index:70;background:rgba(5,7,10,.72);display:none;align-items:flex-end;justify-content:center}
#confirm.on,#pinsheet.on{display:flex}
.sheet{width:100%;max-width:560px;background:var(--panel);border:1px solid var(--line);border-bottom:0;border-radius:20px 20px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom))}
.sheet h3{margin:0 0 4px;font-size:18px}
.sheet .crow{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid var(--line-soft);font-size:13.5px}
.sheet .crow:last-of-type{border-bottom:0}
.sheet .crow .k{color:var(--muted);flex:0 0 auto}
.sheet .crow .v{text-align:right;word-break:break-all;font-variant-numeric:tabular-nums}
.sheet .crow .v small{display:block;color:var(--faint);font-size:11.5px}
/* entropy pad */
.entropad{position:relative;height:150px;background:var(--panel);border:1px dashed var(--line);border-radius:12px;overflow:hidden;touch-action:none;cursor:crosshair}
.entropad canvas{width:100%;height:100%;display:block}
.entrohint{position:absolute;inset:0;display:grid;place-items:center;color:var(--faint);font-size:13px;pointer-events:none}
/* message tools */
.msgtools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px}
.msgex{font-size:12px;font-weight:600;color:var(--accent);cursor:pointer;border:1px solid var(--line);border-radius:999px;padding:4px 11px;background:var(--panel)}
.msgex:hover{border-color:var(--accent)}
.msgcount{font-size:11px;color:var(--faint);margin-left:auto;font-variant-numeric:tabular-nums}
.msgcount.over{color:var(--bad)}
/* confirm quiz */
.qrow{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:12px 14px;margin-bottom:8px}
.qrow .qk{font-size:13px;font-weight:700;margin-bottom:8px}
.qrow .qk i{color:var(--accent);font-style:normal}
.qchips{display:flex;gap:8px}
.qchip{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:9px;padding:10px 4px;font-family:var(--mono);font-size:13px;font-weight:600;min-height:0}
.qchip.sel{background:#243447;border-color:#4a7fb5;color:#cfe6ff}
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
/* centered receive card */
.qrbox{display:inline-block;background:#eef2f6;padding:12px;border-radius:16px;margin-bottom:12px;line-height:0}
.qrbox img{width:172px;height:172px;display:block;border-radius:6px}
.qrbox.noaddr{display:none}
#acc_addr{font-size:12px;color:var(--muted);max-width:300px;margin:0 auto;cursor:pointer;line-height:1.5}
.balstrip{display:flex;align-items:center;gap:12px}
@media(min-width:600px){main{padding-top:8px}}
</style></head>
<body>

<div id="unlock">
  <div class="ucore">
    <div style="font-size:32px;font-weight:800;letter-spacing:-.02em">Olesia<span class="ldot">.</span></div>
    <h2 style="margin:14px 0 2px;font-size:18px">Enter your PIN</h2>
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

<div id="pinsheet">
  <div class="sheet" style="text-align:center">
    <h3 id="ps_title">Choose a PIN</h3>
    <p class="hint" id="ps_sub" style="margin:2px 0 0">6+ digits — you'll enter this to unlock</p>
    <div class="pindots" id="ps_dots" style="justify-content:center"></div>
    <span id="ps_msg" class="hint" style="min-height:15px;display:block;margin:0"></span>
    <div class="pad" id="ps_pad">
      <button type="button" data-k="1">1</button><button type="button" data-k="2">2</button><button type="button" data-k="3">3</button>
      <button type="button" data-k="4">4</button><button type="button" data-k="5">5</button><button type="button" data-k="6">6</button>
      <button type="button" data-k="7">7</button><button type="button" data-k="8">8</button><button type="button" data-k="9">9</button>
      <button type="button" class="ghost" id="ps_abc" title="use a passphrase">abc</button><button type="button" data-k="0">0</button><button type="button" class="ghost" data-k="back">⌫</button>
    </div>
    <div class="field" id="ps_textrow" style="display:none;margin-top:12px"><input id="ps_text" type="password" placeholder="passphrase (6+ chars)" autocomplete="off"></div>
    <div class="row" style="margin-top:14px"><button type="button" class="sec" id="ps_cancel">Cancel</button><button type="button" id="ps_ok">Continue</button></div>
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
  <span class="logo">Olesia<span class="ldot">.</span></span>
  <span class="hbtns">
    <button id="lockbtn" title="Lock wallet">🔒</button>
    <span class="netchip" id="netchip"><span class="sw"></span><span id="netname">testnet4</span></span>
  </span>
</header>
<main>

<!-- ============ WELCOME ============ -->
<section class="pane" id="pane-welcome">
  <div style="text-align:center;padding:26px 0 8px">
    <div style="font-size:40px;font-weight:800;letter-spacing:-.02em">Olesia<span class="ldot">.</span></div>
    <p class="sub" style="margin:6px auto 0;max-width:32ch">Learn Bitcoin by doing — hands-on with every address type, on testnets or real mainnet.</p>
  </div>

  <p class="netlabel">Network<span class="ldot">.</span></p>
  <div id="netpills" class="netpills"></div>
  <select id="net" style="display:none"></select>
  <div id="mainwarn" class="warn" style="margin:12px 0 0;display:none"></div>

  <button id="w_create" style="width:100%;font-size:15.5px;padding:15px;margin-top:18px">＋ Create a new wallet</button>
  <button id="w_import" class="sec" style="width:100%;margin-top:8px;font-size:15px;padding:14px">↓ Import an existing wallet</button>

  <div class="warn" style="margin-top:18px">🔥 <b>This is a hot wallet — for learning and small amounts only.</b> Your keys live in this browser. Perfect for practice and pocket-money sums you'd accept losing — but <b>never keep meaningful savings, or your full stack, here.</b></div>
  <p class="hint" style="text-align:center;margin-top:12px">Holding real value? Generate offline with the <a href="https://offline.olesia.io" target="_blank" rel="noopener">cold generator</a>, then use this app <b>watch-only</b> and sign offline. <a href="https://olesia.io/learn/#security" target="_blank" rel="noopener">Why →</a></p>
  <p class="hint" style="text-align:center;margin-top:10px">Non-custodial · open source · <a href="https://github.com/testnetbtc/BTC_Wallet" target="_blank" rel="noopener">verify everything</a> · <a href="https://olesia.io/learn/" target="_blank" rel="noopener">learn the basics</a></p>
</section>

<!-- ============ CREATE 1: ENTROPY ============ -->
<section class="pane" id="pane-create1">
  <button class="back" id="c_back0">‹ Back</button>
  <h2>Create your wallet</h2>
  <p class="sub">Step 1 of 4 — randomness</p>
  <div class="card">
    <p class="hint" style="margin-top:0">Your wallet is a giant secret number. Olesia always draws <b>256 bits from your device's cryptographic random generator</b> — that alone is unguessable (more possible keys than atoms in the universe).</p>
    <p class="hint"><a id="extra_tog" style="cursor:pointer">＋ Add your own entropy (optional) ▾</a></p>
    <div id="extra_body" style="display:none">
      <p class="hint">Don't fully trust any single source? Add your own — everything is <b>hashed together</b>, so the result is strong if <i>any one</i> source is strong. It can only help.</p>
      <label>Dice rolls <span class="hint" style="display:inline">— roll a real die, type the results (1–6)</span></label>
      <input id="dice" placeholder="e.g. 4152663125…  (50+ rolls ≈ 129 bits)" inputmode="numeric" autocomplete="off">
      <label>Passphrase — the “25th word” <span class="help" data-target="tip_pass">?</span></label>
      <div class="tiptext" id="tip_pass">An extra secret applied ON TOP of your words (BIP-39). The same 24 words with a different passphrase = a completely different wallet. Powerful — but <b>if you lose it, the coins are gone forever</b>; it is not written on your paper backup and there is no way to recover it. Leave empty unless you understand this.</div>
      <input id="c_pass" type="password" placeholder="optional — leave empty for none" autocomplete="off">
      <label>Random movement <span class="hint" style="display:inline">— wiggle your mouse or doodle with your finger</span></label>
      <div class="entropad" id="entropad"><canvas id="entrocanvas"></canvas><span class="entrohint" id="entrohint">draw here ✏️</span></div>
      <div class="prog" style="margin:8px 0 2px"><i id="entrobar"></i></div>
      <p class="hint" id="entromsg" style="margin:2px 0 0">0% — every wiggle adds randomness</p>
    </div>
  </div>
  <button id="c_gen" style="width:100%;font-size:15px;padding:14px">Generate my 24 words</button>
</section>

<!-- ============ CREATE 2: WRITE DOWN ============ -->
<section class="pane" id="pane-create2">
  <button class="back" id="c_back1">‹ Start over</button>
  <h2>Write these down</h2>
  <p class="sub">Step 2 of 4 — your seed phrase</p>
  <div class="warn">These 24 words <b>are</b> your wallet — anyone who has them controls the coins, and there is no reset. Write them on <b>paper</b>, in order. Never screenshot or cloud-sync them.</div>
  <div class="seedgrid" id="c_words"></div>
  <button id="c_wrote" style="width:100%;font-size:15px;padding:14px;margin-top:6px">I've written them down →</button>
</section>

<!-- ============ CREATE 3: CONFIRM ============ -->
<section class="pane" id="pane-create3">
  <button class="back" id="q_back">‹ Show the words again</button>
  <h2>Prove it 😉</h2>
  <p class="sub">Step 3 of 4 — tap the right word for each position</p>
  <div id="q_box"></div>
  <button id="q_check" style="width:100%;font-size:15px;padding:14px;margin-top:6px" disabled>Check my answers</button>
</section>

<!-- ============ CREATE 4: DONE / SAVE ============ -->
<section class="pane" id="pane-create4">
  <h2>Backup confirmed ✓</h2>
  <p class="sub">Step 4 of 4 — how should this device remember your wallet?</p>
  <div class="warn" id="c_replacenote" style="display:none">This device already has a saved wallet — saving this one <b>replaces</b> it here. (The old wallet's coins are safe on-chain; you can always re-import it from its words.)</div>
  <div class="card">
    <label style="margin-top:0">Keep it on this device (recommended)</label>
    <p class="hint">Saved <b>encrypted</b> behind a PIN (scrypt + XChaCha20-Poly1305). The plaintext seed never touches disk — your PIN decrypts it in memory each time.</p>
    <button id="c_save" style="width:100%">Set a PIN &amp; save</button>
  </div>
  <button id="c_skip" class="sec" style="width:100%">Don't save — open once, ask for the words next time</button>
</section>

<!-- ============ IMPORT ============ -->
<section class="pane" id="pane-import">
  <button class="back" id="i_back">‹ Back</button>
  <h2>Import a wallet</h2>
  <p class="sub">Paste a seed phrase (12/24 words) — or an account xpub to watch a balance without spend power.</p>
  <div class="card">
    <label style="margin-top:0">Seed or xpub <span class="help" data-target="tip_seed">?</span></label>
    <div class="tiptext" id="tip_seed">Your wallet <i>is</i> its words (BIP-39) — anyone with them controls the coins. An <b>xpub</b> can watch a balance but cannot spend: the safe way to use a cold wallet online. Private-key (WIF) and encrypted-file import are coming next.</div>
    <textarea id="mnemonic" placeholder="word1 word2 … word24   —or—   xpub…/tpub…" autocomplete="off" spellcheck="false"></textarea>
    <label>Passphrase <span class="hint" style="display:inline">— only if the wallet was made with one</span></label>
    <input id="i_pass" type="password" placeholder="optional — leave empty for none" autocomplete="off">
    <div class="row">
      <button type="button" class="sec paste" data-paste="mnemonic">Paste</button>
      <button id="load">Open wallet</button>
    </div>
  </div>
  <p class="hint">Made your seed with the <a href="https://offline.olesia.io" target="_blank" rel="noopener">cold generator</a>? Pasting the words here makes it a <b>hot</b> wallet — fine for practice/small amounts. For real funds, import its <b>xpub</b> instead and sign offline (Settings → Air-gap).</p>

  <div style="text-align:center;color:var(--faint);font-size:12px;margin:8px 0">— or —</div>
  <div class="card">
    <label style="margin-top:0">Import a cold-generator backup file</label>
    <p class="hint">The encrypted <code>.json</code> you saved from <a href="https://offline.olesia.io" target="_blank" rel="noopener">offline.olesia.io</a> — decrypted here in your browser.</p>
    <input id="bkfile" type="file" accept="application/json,.json" style="padding:9px">
    <input id="bkpass" type="password" placeholder="file password" autocomplete="off" style="margin-top:6px">
    <button id="bkimport" class="sec" style="width:100%;margin-top:6px">Decrypt &amp; open</button>
    <p class="hint" id="bkinfo" style="margin:6px 0 0"></p>
  </div>
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
  <p class="sub" style="margin-bottom:4px"><span id="acc_one"></span> · <a id="acc_moretog" style="cursor:pointer">about ▾</a></p>
  <p class="hint mono" style="margin:0 0 10px;font-size:11.5px">derivation path <span id="acc_path" style="color:var(--accent)"></span> <span class="help" data-target="tip_path">?</span></p>
  <div class="tiptext" id="tip_path" style="margin:0 0 10px">The route from your seed to this account's key: <b>m / purpose' / coin' / account' / chain / index</b>. The first number is the script-type standard (44'=legacy, 49'=nested, 84'=SegWit, 86'=Taproot); coin is 0' for mainnet, 1' for test networks. Same seed + same path = same keys, in any BIP-compliant wallet — that's why your seed restores anywhere.</div>
  <div class="tiptext" id="acc_about" style="margin:0 0 12px"></div>

  <div class="card" style="text-align:center;padding:20px 16px 16px">
    <div class="qrbox"><img id="acc_qr" alt="address QR"></div>
    <div class="mono" id="acc_addr" title="tap to copy"></div>
    <div class="row" style="margin-top:12px">
      <button type="button" class="copy" data-copy="acc_addr">Copy address</button>
      <button type="button" class="sec" id="acc_sendbtn">Send</button>
    </div>
    <p class="hint" id="acc_recvhint" style="margin:10px 0 0">Scan or copy to receive. Need coins? <a href="https://olesia.io/faucet/" target="_blank" rel="noopener">Free testnet coins →</a></p>
  </div>

  <div class="card balstrip">
    <div style="flex:1;text-align:left">
      <div style="font-size:10.5px;letter-spacing:.09em;font-weight:800;color:var(--faint)">BALANCE</div>
      <div id="acc_bal" style="font-size:19px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:2px">—</div>
      <div class="hint" id="acc_utxos" style="margin:2px 0 0"></div>
    </div>
    <button type="button" class="sec" id="acc_refresh" style="min-height:36px;font-size:12.5px">↻ Refresh</button>
  </div>

  <div class="card">
    <div class="sect" style="margin-top:0"><h3>History</h3></div>
    <div id="acc_hist" class="hint">—</div>
  </div>
  <input id="acc_label" placeholder="＋ Add a private label (stays on this device)" autocomplete="off" style="background:none;border:1px dashed var(--line);text-align:center;font-size:13.5px">

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
    <input id="p2pk_msg" placeholder="optional message written on-chain (≤80 bytes)" autocomplete="off" style="margin-top:6px">
    <div class="msgtools"><span class="msgex" data-fill="p2pk_msg">✍️ Use Satoshi’s 2009 headline</span><span class="msgcount" id="p2pk_msgcount">0 / 80 bytes</span></div>
    <p class="hint" style="margin:6px 0 0">✨ A message written on-chain while spending <i>Satoshi's own script type</i> — the closest a modern user gets to the genesis-block headline.</p>
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
  <div class="card" style="padding:10px 14px">
    <label style="margin:0 0 8px;font-size:13px;color:var(--muted)">What do you want to do?</label>
    <div class="feeps" id="send_mode">
      <button type="button" class="feep active" data-mode="pay">💸 Pay someone</button>
      <button type="button" class="feep" data-mode="msg">✍️ Just write a message</button>
    </div>
  </div>
  <div class="card" id="send_pay">
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
    <div class="msgtools"><span class="msgex" data-fill="msg">✍️ Use Satoshi’s 2009 headline</span><span class="msgcount" id="msgcount">0 / 80 bytes</span></div>
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
    <div class="srow" id="set_addwallet"><span>➕</span><span class="t"><b>Create or import another wallet</b><span>closes the current one first</span></span><span class="val">›</span></div>
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
    <button id="vsave" class="sec" style="width:100%">Set a PIN &amp; save</button>
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
  <button data-nav="home" class="on"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/></svg></span>Home</button>
  <button data-nav="accounts"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5"/></svg></span>Accounts</button>
  <button data-nav="learn"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5zM19 19a2 2 0 01-2 2H6"/><path d="M8 3v14"/></svg></span>Learn</button>
  <button data-nav="settings"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.6-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3h0a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.6h0a1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9v0a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg></span>Settings</button>
</div></nav>
</div>

<div id="toast"></div>
<script>${bundle}</script>
<script>${ui}</script>
</body></html>`;
writeFileSync('web/index.html', html);
console.log('web/index.html bytes:', html.length);
