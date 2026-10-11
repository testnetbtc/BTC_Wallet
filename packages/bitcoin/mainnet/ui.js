// Olesia mainnet wallet — UI wiring. All cryptography lives in window.OM (entry.js); this
// file is state + DOM only. Untrusted text (addresses, txids, node messages) is only ever
// placed with textContent, never innerHTML.
//
// SECRET HANDLING: once a wallet is open this file holds NO recovery phrase, private key or
// password. `wallet` is a watch-only session plus the encrypted wallet; signing a payment and
// showing the recovery words each ask for the password. A secret is held in plain form only
// between generating/typing it and writing its encrypted file (`draft`, `pending`).
(function () {
  const OM = window.OM;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const show = (el, on = true) => el.classList.toggle('hide', !on);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btc = (sats) => { const s = String(Math.abs(sats)).padStart(9, '0'); return (sats < 0 ? '-' : '') + s.slice(0, -8) + '.' + s.slice(-8); };
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const tr = window.OI18N.t;   // every string a person reads goes through here (see i18n.js)

  // ---------- state ----------
  let wallet = null;      // the open wallet: { networks, home, practiceOnly, session(network) (watch-only), prepare(network, args, password), reveal(password) }
  let net = 'mainnet';    // the network being shown
  let makeNet = 'mainnet';   // the network a wallet being created / imported is for: mainnet, or testnet4 for a practice-only wallet
  // Practice networks shown by default: Testnet 4 only. Signet and Testnet 3 stay behind a Settings switch.
  const MORE_NETS_KEY = 'olesia:mainnet:morenets';
  const moreNets = () => { try { return localStorage.getItem(MORE_NETS_KEY) === 'on'; } catch { return false; } };
  const visibleNets = () => (wallet ? wallet.networks.filter((n) => n === 'mainnet' || n === 'testnet4' || moreNets()) : []);
  let session = null;     // = wallet.session(net)
  const info = () => OM.netInfo[net];
  let draft = null;       // wallet being created: { mnemonic, words, sources }
  let pending = null;     // secret waiting for its wallet file: { kind:'seed', mnemonic, passphrase } | { kind:'wif', wif }
  let ready = null;       // locked wallet built at save time, opened by "Open my wallet"
  let saveMode = 'create';   // 'create' | 'import' | 'convert'
  let lastFile = null;    // { name, text } — the ENCRYPTED file, kept so it can be downloaded again
  let lastGenerated = '';  // the password the generator produced (to label its strength honestly)
  let selfOk = false;
  const picked = new Set();   // coin control

  // ---------- toast ----------
  let toastT;
  function toast(msg, cls) {
    const box = $('#toast'); box.textContent = msg; box.className = cls || ''; box.style.display = 'block';
    clearTimeout(toastT); toastT = setTimeout(() => { box.style.display = 'none'; }, cls === 'bad' ? 7000 : 3500);
  }

  // ---------- languages ----------
  // The chip in the header lists every language the page has a dictionary for (i18n.js). Static
  // text is re-walked by OI18N.apply(); the lines this script paints are re-worded by rewordAll().
  const I18N = window.OI18N, langSel = $('#lang');
  I18N.LANGS.forEach(([c, name]) => { const o = el('option', null, name); o.value = c; langSel.appendChild(o); });
  langSel.addEventListener('change', async () => {
    const r = await I18N.set(langSel.value);
    if (!r.ok) { toast(tr('That language could not be loaded ({error}). Languages need the online page at olesia.io.', { error: r.error }), 'bad'); langSel.value = I18N.code; }
  });
  I18N.onChange(() => { langSel.value = I18N.code; rewordAll(); });
  function rewordAll() {
    for (const f of [rngRender, nodeRender, priceRender, sessionRender, networkRender, padRender, diceRender, genRender, saveRender, renderFees, noteRender, introReword, streetReword]) { try { f(); } catch { /* a screen that is not set up yet has nothing to re-word */ } }
    try { if (session && session.scanned) renderWallet(); } catch { /* same */ }
    try { if (wallet) { renderNetworks(); renderFaucet(); } } catch { /* same */ }
    try { createRender(); } catch { /* same */ }
    try { if ($('#pane-vanity').classList.contains('on')) vanityRender(); } catch { /* same */ }
  }

  // ---------- panes ----------
  const TAB_OF = { wallet: 'wallet', receive: 'wallet', send: 'wallet', networks: 'networks', faucet: 'faucet', street: 'street', settings: 'settings' };
  function pane(name) {
    if (TAB_OF[name] && name !== 'street' && !session) name = 'welcome';   // the street is open to everyone
    $$('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + name));
    show($('#tabbar'), !!session && !!TAB_OF[name]);
    $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === TAB_OF[name]));
    document.body.classList.toggle('wide', name === 'street');
    show($('#st_back'), name === 'street' && !session);
    if (name === 'street') streetPaneOpen(); else streetPaneClose();
    hideReveal(); closeConfirm(false); closePw(null);
    if (name !== 'open') resetOpen();   // a decrypted-but-not-yet-opened file is dropped when leaving that screen
    if (name !== 'vanity' && name !== 'save') vanityLeave();   // an unsaved vanity key is dropped when leaving that screen
    if (name !== 'paper' && name !== 'save') paperLeave();     // same for a paper-wallet key
    if (name !== 'send') p2pkFund = null;                        // a P2PK destination lives only on the Send screen
    window.scrollTo(0, 0);
  }
  $$('.back[data-go]').forEach((b) => b.addEventListener('click', () => pane(b.dataset.go)));
  $$('#tabbar button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.tab === 'networks') renderNetworks();
    if (b.dataset.tab === 'faucet') renderFaucet();
    pane(b.dataset.tab);
  }));
  $('#w_streetpage').addEventListener('click', () => pane('street'));
  $('#st_back').addEventListener('click', () => pane('welcome'));
  $('#netbtn').addEventListener('click', () => { if (session) { renderNetworks(); pane('networks'); } });

  // ---------- startup: self-check + node status ----------
  (function boot() {
    let sc; try { sc = OM.selfCheck(); } catch (e) { sc = { ok: false, results: [{ name: e.message, ok: false }] }; }
    selfOk = sc.ok;
    if (!sc.ok) {
      const box = $('#selfcheck'); show(box);
      box.textContent = tr('This copy of the wallet failed its built-in cryptography self-check ({names}). Creating, opening and importing wallets is disabled. Do not use it.', { names: sc.results.filter((r) => !r.ok).map((r) => r.name).join(', ') });
      ['#w_create', '#w_open', '#w_import'].forEach((s) => { $(s).disabled = true; });
    }
    const h = OM.rngHealth();
    rngRender();
    nodeStatus(); setInterval(nodeStatus, 60000);
    priceTick(); setInterval(priceTick, 60000);
  })();
  function rngRender() {
    const h = OM.rngHealth();
    $('#rngmsg').textContent = h.ok ? tr('✓ The system random number generator is responding normally.') : tr('✗ {reason} — only dice-only mode can be used on this device.', { reason: h.reason });
    $('#rngmsg').className = 'hint ' + (h.ok ? 'ok' : 'bad');
  }
  let nodeSeen = null;   // the last /status answer, so the chip can be re-worded in a new language
  async function nodeStatus() {
    try { nodeSeen = await OM.status(); } catch { nodeSeen = { unreachable: true }; }
    nodeRender();
  }
  function nodeRender() {
    const c = $('#chip_node'), txt = $('#chip_node_t'), s = nodeSeen;
    if (!s) return;
    if (s.unreachable) { c.className = 'chip warn'; txt.textContent = tr('node unreachable'); return; }
    if (s.chain !== 'main') { c.className = 'chip err'; txt.textContent = tr('node on wrong network'); return; }
    c.className = 'chip ' + (s.ibd ? 'warn' : 'ok');
    txt.textContent = s.ibd ? tr('node syncing · {n}', { n: Number(s.blocks).toLocaleString('en-US') }) : tr('node · block {n}', { n: Number(s.blocks).toLocaleString('en-US') });
  }

  // ---------- market price (display only; fetched by the Olesia node, never by this page) ----------
  const CUR = { usd: '$', gbp: '£', eur: '€' }, CUR_ORDER = ['usd', 'gbp', 'eur'];
  let quotes = null, cur = 'usd';
  try { const c = localStorage.getItem('olesia:mainnet:cur'); if (CUR[c]) cur = c; } catch { /* default */ }
  const fiat = (sats) => { const q = quotes && quotes[cur]; if (!q) return ''; const v = sats / 1e8 * q.price; return '≈ ' + CUR[cur] + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  function priceRender() {
    const chip = $('#chip_price'), q = quotes && quotes[cur];
    show(chip, !!q);
    if (q) {
      $('#price_v').textContent = 'BTC ' + CUR[cur] + Math.round(q.price).toLocaleString('en-US');
      const up = q.change24h >= 0, ch = $('#price_c');
      ch.textContent = (up ? '▲ +' : '▼ −') + Math.abs(q.change24h).toFixed(2) + '%';
      ch.className = up ? 'up' : 'down';
    }
    if (session && session.scanned) { const sm = session.summary(); $('#bal_fiat').textContent = info().test ? '' : fiat(sm.confirmed + sm.pendingChange); }
  }
  async function priceTick() {
    try { const p = await OM.price(); quotes = p && p.available ? p.quotes : null; } catch { quotes = null; }
    priceRender();
  }
  $('#chip_price').addEventListener('click', () => {
    const have = CUR_ORDER.filter((c) => quotes && quotes[c]); if (!have.length) return;
    cur = have[(have.indexOf(cur) + 1) % have.length];
    try { localStorage.setItem('olesia:mainnet:cur', cur); } catch { /* not persisted */ }
    priceRender();
  });

  // ---------- password prompt: every action that needs a key goes through here ----------
  let pwClose = null;
  function closePw(v) { if (pwClose) { const c = pwClose; pwClose = null; c(v); } }
  // fn(password, onProgress) does the work. A wrong password keeps the prompt open for another try.
  // Resolves { ok:true, value } | { ok:false, cancelled:true } | { ok:false, error }.
  function withPassword(title, note, fn) {
    return new Promise((resolve) => {
      const sheet = $('#pwsheet'), inp = $('#p_pw'), msg = $('#p_msg'), go = $('#p_go');
      let busy = false;
      $('#p_title').textContent = title; $('#p_note').textContent = note;
      inp.value = ''; inp.type = 'password'; msg.textContent = ''; show($('#p_progbar'), false); go.disabled = false;
      const finish = (r) => { sheet.classList.remove('on'); inp.value = ''; go.onclick = null; $('#p_cancel').onclick = null; inp.onkeydown = null; pwClose = null; resolve(r); };
      pwClose = () => { if (!busy) finish({ ok: false, cancelled: true }); };
      const submit = async () => {
        if (busy) return;
        const pw = inp.value;
        if (!pw) { msg.textContent = tr('Enter your wallet password.'); return; }
        busy = true; go.disabled = true; msg.textContent = tr('Unlocking…'); show($('#p_progbar')); $('#p_prog').style.width = '0%';
        await tick();
        try { const value = await fn(pw, (p) => { $('#p_prog').style.width = Math.round(p * 100) + '%'; }); busy = false; finish({ ok: true, value }); }
        catch (e) {
          busy = false; go.disabled = false; show($('#p_progbar'), false);
          if (/wrong password/i.test(e.message)) { msg.textContent = tr('✗ Wrong password — try again.'); inp.value = ''; inp.focus(); }
          else finish({ ok: false, error: e });
        }
      };
      go.onclick = submit; $('#p_cancel').onclick = () => closePw(null);
      inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      sheet.classList.add('on'); setTimeout(() => inp.focus(), 30);
    });
  }

  // ---------- lock: a full reload drops everything this tab holds ----------
  const lock = () => { location.reload(); };
  $('#lockbtn').addEventListener('click', lock);
  $('#set_lock').addEventListener('click', lock);
  let idleT;
  const IDLE_MS = 15 * 60 * 1000;
  function armIdle() { clearTimeout(idleT); if (session || draft || pending) idleT = setTimeout(lock, IDLE_MS); }
  ['pointerdown', 'keydown', 'pointermove'].forEach((ev) => document.addEventListener(ev, armIdle, { passive: true }));

  // =====================================================================================
  // CREATE
  // =====================================================================================
  let words = 24, addrType = 'p2wpkh', mouse = [], samples = 0;
  const SAMPLE_TARGET = 256, SAMPLE_MAX = 4096;
  $('#w_create').addEventListener('click', () => { resetCreate('mainnet'); pane('create1'); });
  $('#w_practice').addEventListener('click', () => { resetCreate('testnet4'); pane('create1'); });
  function resetCreate(forNet = 'mainnet') {
    draft = null; mouse = []; samples = 0; words = 24; addrType = 'p2wpkh'; makeNet = forNet;
    $$('#c_len button').forEach((b) => b.classList.toggle('on', b.dataset.words === '24'));
    $$('#c_type button').forEach((b) => b.classList.toggle('on', b.dataset.type === 'p2wpkh'));
    $$('#c_net button').forEach((b) => b.classList.toggle('on', b.dataset.net === makeNet));
    createRender();
    $('#dice').value = ''; $('#diceonly').checked = false; $('#padskip').checked = false;
    $('#c_words').textContent = ''; $('#c_wrote').checked = false; $('#c_next2').disabled = true;
    $('#pad').classList.remove('done'); $('#padhint').textContent = tr('move your mouse in here');
    padRender(); diceRender();
  }
  $$('#c_len button').forEach((b) => b.addEventListener('click', () => {
    words = Number(b.dataset.words);
    $$('#c_len button').forEach((x) => x.classList.toggle('on', x === b));
    diceRender();
  }));
  $$('#c_type button').forEach((b) => b.addEventListener('click', () => {
    addrType = b.dataset.type;
    $$('#c_type button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $$('#c_net button').forEach((b) => b.addEventListener('click', () => {
    makeNet = b.dataset.net;
    $$('#c_net button').forEach((x) => x.classList.toggle('on', x === b));
    createRender();
  }));
  // the words that change with the network a wallet is being made for
  function createRender() {
    const practice = makeNet === 'testnet4';
    $('#c_title').textContent = practice ? tr('Create a practice wallet') : tr('Create a wallet');
    $('#c_nethint').textContent = practice
      ? tr('A practice wallet lives on Testnet 4 only: free coins from the faucet, nothing at stake, and words that were never used for real money. Pick this to learn.')
      : tr('A real wallet also gets a Testnet 4 practice side from the same words — handy, but those words then guard real coins while you practise. If you would rather keep the two apart, make a separate practice wallet.');
    $('#c_type').classList.toggle('hide', practice && false);
    $$('#c_type button').forEach((b) => { const t = b.dataset.type; b.textContent = practice ? ({ p2wpkh: tr('SegWit · tb1q…'), p2tr: tr('Taproot · tb1p…'), p2pkh: tr('Legacy · m…/n…') })[t] : ({ p2wpkh: tr('SegWit · bc1q…'), p2tr: tr('Taproot · bc1p…'), p2pkh: tr('Legacy · 1…') })[t]; });
  }
  // movement entropy: pointer position + sub-millisecond timing, 8 bytes per sample
  function sample(e) {
    if (samples >= SAMPLE_MAX) return;
    const r = $('#pad').getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) * 16) & 0xffff, y = Math.round((e.clientY - r.top) * 16) & 0xffff;
    const t = Math.floor(performance.now() * 1000) >>> 0;
    mouse.push(x >> 8, x & 255, y >> 8, y & 255, t >>> 24, (t >>> 16) & 255, (t >>> 8) & 255, t & 255);
    samples++; padRender();
  }
  function padRender() {
    const pct = Math.min(100, Math.round(samples / SAMPLE_TARGET * 100));
    $('#padbar').style.width = pct + '%';
    $('#padmsg').textContent = pct >= 100 ? tr('100% collected — plenty (more is fine, it all gets mixed in)') : tr('{pct}% collected', { pct });
    if (pct >= 100) { $('#pad').classList.add('done'); $('#padhint').textContent = tr('✓ thank you — keep going if you like'); }
    genRender();
  }
  let dragging = false;
  $('#pad').addEventListener('pointerdown', (e) => { dragging = true; sample(e); });
  $('#pad').addEventListener('pointermove', (e) => { if (dragging || e.pointerType === 'mouse') sample(e); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('#pad').addEventListener(ev, () => { dragging = false; }));
  $('#padskip').addEventListener('change', genRender);
  $('#dice').addEventListener('input', diceRender);
  $('#diceonly').addEventListener('change', diceRender);
  function diceRender() {
    const d = OM.dice($('#dice').value);
    const need = d.need[words === 24 ? 256 : 128];
    $('#diceneed').textContent = need;
    const m = $('#dicemsg');
    if (!d.ok) { m.textContent = '✗ ' + tr(d.error); m.className = 'hint bad'; }
    else if (!d.rolls) { m.textContent = tr('no rolls entered'); m.className = 'hint'; }
    else { m.textContent = (d.rolls === 1 ? tr('1 roll ≈ {bits} bits of dice randomness', { bits: d.bits.toFixed(0) }) : tr('{n} rolls ≈ {bits} bits of dice randomness', { n: d.rolls, bits: d.bits.toFixed(0) })) + ($('#diceonly').checked ? ' ' + tr('({n} more needed)', { n: Math.max(0, need - d.rolls) }) : ' ' + tr('— mixed in on top of the system randomness')); m.className = 'hint'; }
    genRender();
  }
  function genRender() {
    const b = $('#c_gen'), d = OM.dice($('#dice').value), need = d.need[words === 24 ? 256 : 128];
    let label = tr('Generate {n}-word wallet', { n: words }), ok = selfOk;
    if (!d.ok) { ok = false; label = tr('Fix the dice rolls first'); }
    else if ($('#diceonly').checked) { if (d.rolls < need) { ok = false; label = need - d.rolls === 1 ? tr('Dice-only needs 1 more roll') : tr('Dice-only needs {n} more rolls', { n: need - d.rolls }); } }
    else if (samples < SAMPLE_TARGET && !$('#padskip').checked) { ok = false; label = tr('Move your mouse to continue'); }
    b.disabled = !ok; b.textContent = label;
  }
  $('#c_gen').addEventListener('click', () => {
    try {
      const diceOnly = $('#diceonly').checked;
      const r = OM.create({ words, mouse: new Uint8Array(mouse), dice: $('#dice').value, diceOnly });
      draft = { mnemonic: r.mnemonic, words: r.words, sources: r.sources };
      mouse = []; samples = 0; $('#dice').value = '';
      renderWords($('#c_words'), draft.mnemonic);
      const s = r.sources;
      $('#c_sources').textContent = diceOnly
        ? tr('Made from your {n} dice rolls only: the words are SHA-256 of the roll string. No computer randomness was used.', { n: s.diceRolls })
        : tr('{bits}-bit entropy. Sources hashed together: system generator ✓ · mouse movement {mouse} · dice {dice}.', { bits: r.bits, mouse: s.mouseBytes ? '✓' : '–', dice: s.diceRolls ? '✓ (' + tr('{n} rolls', { n: s.diceRolls }) + ')' : '–' });
      $('#c_wrote').checked = false; $('#c_next2').disabled = true;
      armIdle(); pane('create2');
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  function renderWords(box, mnemonic) {
    box.textContent = '';
    mnemonic.split(' ').forEach((w, i) => { const s = el('span'); s.append(el('i', null, String(i + 1)), w); box.appendChild(s); });
  }
  $('#c_wrote').addEventListener('change', () => { $('#c_next2').disabled = !$('#c_wrote').checked; });
  $('#c_back2').addEventListener('click', () => { resetCreate(); pane('create1'); });
  let quiz = [];
  $('#c_next2').addEventListener('click', () => {
    const list = draft.mnemonic.split(' ');
    quiz = OM.randomIndices(4, list.length).map((idx) => ({ idx, answer: list[idx] }));
    const box = $('#q_box'); box.textContent = '';
    quiz.forEach((q, i) => {
      const row = el('div', 'qrow'); row.appendChild(el('span', null, tr('Word #{n}', { n: q.idx + 1 })));
      const inp = el('input'); inp.type = 'text'; inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('autocapitalize', 'none'); inp.id = 'q_in' + i;
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const n = $('#q_in' + (i + 1)); if (n) n.focus(); else $('#q_check').click(); } });
      row.appendChild(inp); box.appendChild(row);
    });
    pane('create3'); const f = $('#q_in0'); if (f) f.focus();
  });
  $('#c_back3').addEventListener('click', () => pane('create2'));
  $('#q_check').addEventListener('click', () => {
    const wrong = quiz.filter((q, i) => $('#q_in' + i).value.trim().toLowerCase() !== q.answer);
    if (wrong.length) return toast(tr('Word #{n} does not match. Check your paper and try again.', { n: wrong[0].idx + 1 }), 'bad');
    openSave('create');
  });

  // =====================================================================================
  // SAVE (.dat)
  // =====================================================================================
  // Every wallet — created, imported, or converted from an old backup — passes through here:
  // it gets a password and an encrypted file before it can be used. There is no way to use a
  // wallet that has no password.
  function openSave(mode) {
    saveMode = mode; lastFile = null; ready = null; lastGenerated = '';
    const creating = mode === 'create';
    $('#s_title').textContent = creating ? (makeNet === 'testnet4' ? tr('Save your practice wallet file') : tr('Save your wallet file')) : mode === 'convert' ? tr('Save as a new wallet file') : tr('Protect this wallet');
    $('#s_sub').textContent = creating
      ? tr('Your wallet is encrypted with a password and saved to this computer as a .dat file. Load that file whenever you want to use the wallet.')
      : mode === 'convert'
        ? tr('This older backup format is being replaced. Choose a password and save the wallet as a new .dat file — from now on, open that file instead.')
        : tr('Before this wallet can be used it needs a password. It is encrypted and saved to this computer as a .dat file; you will type the password each time you send.');
    show($('#s_passbox'), creating);
    show($('#s_storebox'), !creating && pending && pending.kind === 'seed' && !!pending.passphrase);
    $('#s_usepass').checked = false; show($('#s_passfields'), false); $('#s_storepass').checked = false;
    ['#s_pass', '#s_pass2', '#s_pw', '#s_pw2'].forEach((s) => { $(s).value = ''; $(s).type = 'password'; });
    $('#s_show').textContent = tr('Show'); $('#s_policy').textContent = '';
    show($('#s_done'), false); show($('#s_open'), false); show($('#s_again'), false); show($('#s_progbar'), false); show($('#s_go'), true); show($('#s_back'), true);
    armIdle(); saveRender(); pane('save');
  }
  // leaving this step abandons the wallet being made: nothing was saved, nothing is kept
  $('#s_back').addEventListener('click', () => {
    const fromVanity = pending && pending.kind === 'wif' && vanityResult && pending.wif === vanityResult.wif;
    draft = null; pending = null; ready = null;
    if (fromVanity) { pane('vanity'); $('#v_result').scrollIntoView({ block: 'start' }); toast(tr('The vanity address is still here, unsaved.')); } else pane('welcome');
  });
  $('#s_usepass').addEventListener('change', () => { show($('#s_passfields'), $('#s_usepass').checked); show($('#s_storebox'), $('#s_usepass').checked); saveRender(); });
  $('#s_show').addEventListener('click', () => {
    const t = $('#s_pw').type === 'password' ? 'text' : 'password';
    ['#s_pw', '#s_pw2', '#s_pass', '#s_pass2'].forEach((s) => { $(s).type = t; });
    $('#s_show').textContent = t === 'password' ? tr('Show') : tr('Hide');
  });
  $('#s_gen').addEventListener('click', () => {
    let g; try { g = OM.generatePassword(); } catch (e) { return toast('✗ ' + tr(e.message), 'bad'); }
    lastGenerated = g.password;
    ['#s_pw', '#s_pw2'].forEach((s) => { $(s).type = 'text'; $(s).value = g.password; });
    $('#s_show').textContent = tr('Hide'); saveRender();
    toast(tr('Write this password down now. Without it the wallet file can never be opened.'), 'bad');
  });
  ['#s_pw', '#s_pw2', '#s_pass', '#s_pass2'].forEach((s) => $(s).addEventListener('input', saveRender));
  function saveRender() {
    const pw = $('#s_pw').value, p = OM.passwordPolicy(pw), m = $('#s_policy');
    let ok = p.ok && pw === $('#s_pw2').value;
    if (!pw) { m.textContent = ''; }
    else if (!p.ok) { m.textContent = '✗ ' + p.issues.map(tr).join('; '); m.className = 'hint bad'; }
    else if (pw !== $('#s_pw2').value) { m.textContent = tr('✗ the two passwords do not match'); m.className = 'hint bad'; }
    else {
      // only a GENERATED password has a known strength; typed words are as strong as they were random
      m.textContent = pw === lastGenerated ? tr('✓ generated {n}-word password · {bits} bits', { n: p.words, bits: p.bits })
        : p.kind === 'words' ? tr('✓ {n} words — strong only if you picked them at random (the generator does that for you)', { n: p.words })
        : tr('✓ meets the length and variety requirements (its real strength cannot be measured — a generated password is safer)');
      m.className = 'hint ok';
    }
    if (saveMode === 'create' && $('#s_usepass').checked) {
      if (!$('#s_pass').value) ok = false;
      else if ($('#s_pass').value !== $('#s_pass2').value) { ok = false; m.textContent = tr('✗ the two passphrases do not match'); m.className = 'hint bad'; }
    }
    $('#s_go').disabled = !ok;
  }
  function download(name, text) {
    const u = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
    const a = el('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  }
  $('#s_go').addEventListener('click', async () => {
    const password = $('#s_pw').value;
    const storePass = $('#s_storepass').checked;
    const sec = saveMode === 'create' ? { kind: 'seed', mnemonic: draft.mnemonic, passphrase: $('#s_usepass').checked ? $('#s_pass').value : '' } : pending;
    const scriptType = saveMode === 'create' ? addrType : 'p2wpkh';
    const bar = (from, to) => (p) => { $('#s_prog').style.width = Math.round(from + p * (to - from)) + '%'; };
    $('#s_go').disabled = true; show($('#s_progbar')); $('#s_prog').style.width = '0%';
    try {
      let payload;
      if (sec.kind === 'seed') {
        const pp = sec.passphrase || '';
        payload = { kind: 'seed', mnemonic: sec.mnemonic, passphraseUsed: !!pp, passphrase: pp ? (storePass ? pp : null) : '',
                    fingerprint: OM.describe(sec).fingerprint, scriptType };
      } else payload = { kind: 'wif', wif: sec.wif, scriptType };
      await tick();
      const forNet = sec.kind === 'seed' ? makeNet : 'mainnet';   // a single key is mainnet-only
      const text = await OM.seal(payload, password, bar(0, 40), forNet);
      // Never hand out a file that cannot be opened: decrypt what we just made and compare.
      const back = await OM.openFile(text, password, bar(40, 80));
      const same = (sec.kind === 'seed' ? back.payload.mnemonic === sec.mnemonic : back.payload.wif === sec.wif) && back.network === forNet;
      if (!same) throw new Error(tr('the encrypted file failed its own verification — nothing was saved, please try again'));
      // the form this wallet is held in while open: encrypted, under the same password
      const lk = await OM.lock({ secret: sec, password, fileText: text, filePayload: payload, scriptType, network: forNet }, bar(80, 100));
      ready = { pubs: lk.pubs, vaultText: lk.vaultText, scriptType };
      const d = new Date(), z = (n) => String(n).padStart(2, '0');
      const name = `olesia-${forNet === 'testnet4' ? 'practice' : 'wallet'}-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.dat`;
      lastFile = { name, text };
      download(name, text);
      // the plain secret and the password are no longer needed by this page
      draft = null; pending = null; lastGenerated = ''; quiz = []; $('#q_box').textContent = '';
      vanityForget();   // a vanity key, now in its encrypted file, leaves the page too
      ['#s_pw', '#s_pw2', '#s_pass', '#s_pass2'].forEach((s) => { $(s).value = ''; $(s).type = 'password'; });
      $('#c_words').textContent = ''; $('#s_policy').textContent = '';
      const done = $('#s_done'); done.textContent = '';
      done.append(el('b', null, forNet === 'testnet4' ? tr('✓ Practice wallet file created and verified: ') : tr('✓ Wallet file created and verified: ')), name);
      done.appendChild(el('p', 'hint', tr('It was decrypted again with your password to prove it opens. Find it in your Downloads folder and keep a second copy somewhere safe (a USB stick). The file plus its password is everything needed to spend the funds.')));
      done.appendChild(el('p', 'hint', tr('You will be asked for this password each time you send a payment or show your recovery words.')));
      if (sec.kind === 'seed' && sec.passphrase && !storePass) done.appendChild(el('p', 'hint', tr('Your passphrase is NOT in the file — you will be asked for it each time you open the wallet.')));
      if (sec.kind === 'seed' && forNet === 'mainnet') { const w = el('p', 'warn'); w.append(el('b', null, tr('Practice side included.')), ' ' + tr('The same words also give you a Testnet 4 wallet (Networks tab) with free coins from the Faucet tab. They are ONE secret: whoever learns your words while you practise can take your real bitcoin. Never type them into a test site, a "testnet" app or a chat.')); done.appendChild(w); }
      if (forNet === 'testnet4') done.appendChild(el('p', 'hint', tr('This file opens on Testnet 4 only. Its words were never used for real bitcoin — practise freely.')));
      show(done); show($('#s_go'), false); show($('#s_progbar'), false); show($('#s_again')); show($('#s_open')); show($('#s_back'), false);
    } catch (e) { toast('✗ ' + tr(e.message), 'bad'); $('#s_go').disabled = false; show($('#s_progbar'), false); }
  });
  $('#s_again').addEventListener('click', () => { if (lastFile) download(lastFile.name, lastFile.text); });
  $('#s_open').addEventListener('click', () => {
    try { const r = ready; ready = null; startSession(OM.open(r)); }
    catch (e) { toast('✗ ' + tr(e.message), 'bad'); }
  });

  // =====================================================================================
  // OPEN (.dat)
  // =====================================================================================
  let opened = null;   // { res, text, name, pw } — a decrypted file waiting for its BIP-39 passphrase
  const resetOpen = () => { opened = null; $('#o_pw').value = ''; $('#o_pass').value = ''; show($('#o_passrow'), false); };
  $('#w_open').addEventListener('click', () => {
    resetOpen(); $('#o_file').value = ''; $('#o_info').textContent = ''; $('#o_msg').textContent = ''; pane('open');
  });
  const readFile = (f) => new Promise((res, rej) => { if (f.size > 70000) return rej(new Error(tr('that file is too large to be an Olesia wallet file'))); const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error(tr('could not read that file'))); r.readAsText(f); });
  $('#o_file').addEventListener('change', async () => {
    resetOpen(); $('#o_msg').textContent = '';
    const f = $('#o_file').files && $('#o_file').files[0], info = $('#o_info');
    if (!f) { info.textContent = ''; return; }
    try {
      const d = OM.describeFile(await readFile(f));
      info.className = 'hint ' + (d.network === 'mainnet' || d.network === OM.practiceHome ? 'ok' : 'bad');
      info.textContent = d.kind === 'legacy-backup'
        ? tr('Olesia backup file ({network})', { network: d.network }) + (d.network === 'mainnet' ? '' : ' ' + tr('— it was made for a test network; it will be saved again as a Testnet 4 practice wallet'))
        : d.network === OM.practiceHome ? tr('Olesia practice wallet file · Testnet 4 only · created {date}', { date: d.createdAt.slice(0, 10) })
        : tr('Olesia wallet file · {network} · created {date}', { network: d.network, date: d.createdAt.slice(0, 10) });
    } catch (e) { info.className = 'hint bad'; info.textContent = '✗ ' + tr(e.message); }
  });
  [$('#o_pw'), $('#o_pass')].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#o_go').click(); }));
  $('#o_go').addEventListener('click', async () => {
    const msg = $('#o_msg'); msg.className = 'hint';
    const prog = (p) => { $('#o_prog').style.width = Math.round(p * 100) + '%'; };
    try {
      $('#o_go').disabled = true;
      if (!opened) {
        const f = $('#o_file').files && $('#o_file').files[0];
        if (!f) throw new Error(tr('choose your wallet file first'));
        const text = await readFile(f), pw = $('#o_pw').value;
        show($('#o_progbar')); prog(0); msg.textContent = tr('Decrypting…');
        await tick();
        opened = { res: await OM.openFile(text, pw, prog), text, name: f.name, pw };
        $('#o_pw').value = '';
      }
      const { res, text, name, pw } = opened, p = res.payload;
      let secret;
      if (p.kind === 'wif') secret = { kind: 'wif', wif: p.wif };
      else {
        let pp = typeof p.passphrase === 'string' ? p.passphrase : '';
        if (p.passphraseUsed && typeof p.passphrase !== 'string') {
          if ($('#o_passrow').classList.contains('hide')) { show($('#o_passrow')); show($('#o_progbar'), false); msg.textContent = tr('File decrypted. Now enter the passphrase for this wallet.'); $('#o_pass').focus(); return; }
          pp = $('#o_pass').value;
          if (!pp) throw new Error(tr('enter the wallet passphrase'));
          const cand = { kind: 'seed', mnemonic: p.mnemonic, passphrase: pp };
          if (res.legacy) {
            // old backups carry no fingerprint, but they do record the wallet's first address
            const chk = OM.legacyPassphraseCheck({ mnemonic: p.mnemonic, passphrase: pp, legacy: res.legacy });
            if (chk === 'mismatch') throw new Error(tr('that passphrase does not match this wallet'));
            if (chk === 'unknown') toast(tr('This older backup cannot check your passphrase. Wallet fingerprint: {fp} — if that is not the code you expect, the passphrase is wrong.', { fp: OM.describe(cand).fingerprint }), 'bad');
          } else if (p.fingerprint && OM.describe(cand).fingerprint !== p.fingerprint) throw new Error(tr('that passphrase does not match this wallet'));
        }
        secret = { kind: 'seed', mnemonic: p.mnemonic, passphrase: pp };
      }
      if (res.legacy) {   // an old backup must be re-saved in the current format before use (a test-network one becomes a practice wallet)
        pending = secret; makeNet = res.legacy.network === 'mainnet' ? 'mainnet' : 'testnet4'; resetOpen();
        return openSave('convert');
      }
      // hold the wallet ENCRYPTED from here on (re-encrypted with the passphrase only if the file lacks it)
      show($('#o_progbar')); prog(0); msg.textContent = tr('Opening…'); await tick();
      const r = await OM.lock({ secret, password: pw, fileText: text, filePayload: p, scriptType: p.scriptType, network: res.network }, prog);
      lastFile = { name, text };
      resetOpen();
      startSession(OM.open({ pubs: r.pubs, vaultText: r.vaultText, scriptType: p.scriptType }));
    } catch (e) { msg.className = 'hint bad'; msg.textContent = '✗ ' + tr(e.message); }
    finally { $('#o_go').disabled = false; show($('#o_progbar'), false); }
  });

  // =====================================================================================
  // IMPORT
  // =====================================================================================
  let importMode = 'seed';
  $('#w_import').addEventListener('click', () => { $('#i_phrase').value = ''; $('#i_pass').value = ''; $('#i_wif').value = ''; $('#i_msg').textContent = ''; makeNet = 'mainnet'; $$('#i_net button').forEach((x) => x.classList.toggle('on', x.dataset.net === 'mainnet')); pane('import'); });
  $$('#i_net button').forEach((b) => b.addEventListener('click', () => { makeNet = b.dataset.net; $$('#i_net button').forEach((x) => x.classList.toggle('on', x === b)); }));
  $$('#i_mode button').forEach((b) => b.addEventListener('click', () => {
    importMode = b.dataset.mode;
    $$('#i_mode button').forEach((x) => x.classList.toggle('on', x === b));
    show($('#i_seedbox'), importMode === 'seed'); show($('#i_wifbox'), importMode === 'wif'); $('#i_msg').textContent = '';
  }));
  $('#i_go').addEventListener('click', () => {
    const msg = $('#i_msg');
    try {
      if (importMode === 'seed') {
        const m = $('#i_phrase').value;
        if (!OM.validPhrase(m)) throw new Error(OM.diagnose(m));
        const sec = { kind: 'seed', mnemonic: m.trim().toLowerCase().replace(/\s+/g, ' '), passphrase: $('#i_pass').value };
        const d = OM.describe(sec, makeNet);
        pending = sec; $('#i_phrase').value = ''; $('#i_pass').value = '';
        openSave('import');
        if (sec.passphrase) toast(tr('Wallet fingerprint {fp}. The same words and passphrase always give this code — a different code means a different passphrase.', { fp: d.fingerprint }), 'ok');
      } else {
        const wif = $('#i_wif').value.trim();
        OM.wifInfo(wif);
        pending = { kind: 'wif', wif }; $('#i_wif').value = '';
        openSave('import');
      }
    } catch (e) { msg.textContent = '✗ ' + tr(e.message); }
  });

  // =====================================================================================
  // WALLET
  // =====================================================================================
  let autoT;
  const busy = new WeakSet();   // sessions with a lookup in flight
  function startSession(w) {
    wallet = w; picked.clear(); draft = null; pending = null;
    show($('#lockbtn'));
    sessionRender();
    armIdle(); setNetwork(w.home);
    if (w.practiceOnly) toast(tr('Practice wallet open: Testnet 4 only. Get free coins from the Faucet tab.'), 'ok');
    clearInterval(autoT); autoT = setInterval(() => { if (!document.hidden && session && !busy.has(session)) refresh(false, true); }, 120000);
  }
  function sessionRender() {   // the wallet's own lines in Settings (re-worded when the language changes)
    if (!wallet) return;
    const i = wallet.session(wallet.home).info;
    $('#w_kind').textContent = (i.kind === 'seed' ? (i.hasPassphrase ? tr('{n}-word recovery phrase + passphrase', { n: i.words }) : tr('{n}-word recovery phrase', { n: i.words })) : (i.compressed ? tr('Single private key (compressed)') : tr('Single private key (uncompressed)'))) + (wallet.practiceOnly ? ' · ' + tr('practice wallet (Testnet 4 only)') : '');
    $('#set_morenets').checked = moreNets(); show($('#morenets_row'), !wallet.practiceOnly && wallet.networks.length > 1);
    $('#w_fp').textContent = i.fingerprint;
    show($('#a_savefile'), !!lastFile);
    $('#a_reveal').textContent = i.kind === 'seed' ? tr('Show recovery phrase') : tr('Show private key');
  }
  // Show one of this wallet's networks. Mainnet is real bitcoin on the Olesia node; the others
  // are practice networks (same words, separate keys, worthless coins, public relayed data).
  function setNetwork(n) {
    net = n; session = wallet.session(n); picked.clear(); p2pkFund = null;
    networkRender();
    show($('#deeper_row'), session.info.kind === 'seed');
    $('#bal').textContent = '—'; $('#bal_sub').textContent = ''; $('#bal_fiat').textContent = ''; $('#coins').textContent = ''; $('#coins').appendChild(el('p', 'hint', tr('Loading…')));
    show($('#scanbox'), false);
    pane('wallet');
    if (session.scanned) renderWallet(); 
    if (!busy.has(session)) refresh(false, session.scanned);
  }
  function networkRender() {   // the words that depend on which network is shown
    if (!session) return;
    const inf = info();
    $('#netname').textContent = tr(inf.long); $('#netbtn').classList.toggle('test', inf.test);
    $('#hero').classList.toggle('test', inf.test); show($('#testtag'), inf.test);
    $('#bal_unit').textContent = inf.unit; $('#t_unit_coin').textContent = inf.unit; $('#t_to').placeholder = tr(inf.hint);
    $('#w_hint').textContent = inf.test
      ? tr('{network} is a practice network: these coins have no value. Balances are looked up through a public data service relayed by the Olesia server.', { network: tr(inf.long) }) + (wallet.practiceOnly ? '' : ' ' + tr('Remember: this practice wallet and your real one share the same recovery phrase.'))
      : tr('Balances, confirmations and fee estimates all come from one source: the Olesia Bitcoin node. This page cannot check them against a second source, so before treating a large incoming payment as final, confirm it independently. An incoming payment appears here after its first confirmation (about 10 minutes). The price shown is for information only.');
    $('#t_feehint').textContent = inf.test ? tr('Fee estimates come from the public data service. On practice networks almost any fee confirms.') : tr('Fee estimates come from the Olesia node. A higher rate confirms sooner.');
    $('#c_note').textContent = inf.test ? tr('Shown from the signed transaction itself. This is {network}: practice coins, no value.', { network: tr(inf.long) }) : tr('Shown from the signed transaction itself. Bitcoin payments cannot be reversed.');
    $('#w_source').firstChild.textContent = inf.test ? tr('Public data service · block ') : tr('Olesia node · block ');
  }
  async function refresh(force, quiet) {
    const s = session;
    if (!s || busy.has(s)) return;
    busy.add(s); $('#a_refresh').disabled = true;
    const first = !s.scanned, test = OM.netInfo[s.info.network].test, shown = () => s === session;
    if ((!quiet || first) && shown()) { show($('#scanbox')); $('#scanbar').style.width = '2%'; $('#scanmsg').textContent = test ? tr('Looking up your practice coins…') : tr('Contacting the Olesia node…'); }
    try {
      await s.refresh({ force, onProgress: (v) => {
        if (!shown()) return;
        show($('#scanbox'));
        if (v.state === 'queued') { $('#scanmsg').textContent = tr('Waiting for the node (position {n} in the queue)…', { n: v.position }); $('#scanbar').style.width = '3%'; }
        else { const p = Math.max(3, Math.min(99, Math.round(v.progress || 0))); $('#scanbar').style.width = p + '%'; $('#scanmsg').textContent = test ? tr('Looking up your practice coins… {p}%', { p }) : tr('Searching the Bitcoin UTXO set for your coins… {p}% (the first lookup takes a few minutes)', { p }); }
      } });
      if (shown()) { show($('#scanbox'), false); renderWallet(); }
    } catch (e) {
      if (shown()) { $('#scanmsg').textContent = '✗ ' + tr(e.message); $('#scanbar').style.width = '0%'; show($('#scanbox')); if (!quiet) toast('✗ ' + tr(e.message), 'bad'); }
    } finally { busy.delete(s); if (shown()) $('#a_refresh').disabled = false; }
  }
  $('#a_refresh').addEventListener('click', () => refresh(false));
  function renderWallet() {
    const s = session.summary(), inf = info();
    $('#bal').textContent = btc(s.confirmed + s.pendingChange);
    $('#bal_fiat').textContent = inf.test ? '' : fiat(s.confirmed + s.pendingChange);
    const dp = session.depth;
    if (dp) { $('#depth').textContent = tr('Searched the first {n} addresses of this {network} wallet.', { n: dp.range, network: tr(inf.label) }); $('#a_deeper').disabled = dp.range >= dp.max; }
    const parts = [];
    if (s.outgoing) parts.push(tr('{amount} being spent by an unconfirmed transaction', { amount: btc(s.outgoing) }));
    if (s.pendingChange) parts.push(tr('{amount} change returning (unconfirmed)', { amount: btc(s.pendingChange) }));
    if (s.immature) parts.push(tr('{amount} immature', { amount: btc(s.immature) }));
    const waiting = s.confirmed - s.spendable - s.immature;
    if (waiting > 0 && !s.outgoing) parts.push(tr('{amount} waiting for a first confirmation', { amount: btc(waiting) }));
    $('#bal_sub').textContent = parts.length ? parts.join(' · ') : tr('{n} sats spendable', { n: Number(s.spendable).toLocaleString('en-US') });
    $('#w_height').textContent = s.height == null ? '—' : Number(s.height).toLocaleString('en-US');
    const of = $('#oldfmt');
    if (s.oldFormat && session.coinList().some((c) => c.spendable && c.group === 'std')) { show(of); of.textContent = tr('{amount} {unit} is held in very old formats (P2PK / uncompressed key). These coins are spent separately: tick them below, then Send.', { amount: btc(s.oldFormat), unit: inf.unit }); }
    else if (s.oldFormat) { show(of); of.textContent = tr('{amount} {unit} is held as bare public keys (P2PK). Send spends them with the original 2009-style signature.', { amount: btc(s.oldFormat), unit: inf.unit }); }
    else show(of, false);
    renderCoins(); renderActivity();
  }
  function renderCoins() {
    const list = session.coinList(), box = $('#coins'), unit = info().unit; box.textContent = '';
    $('#coins_n').textContent = list.length ? `· ${list.length}` : '';
    for (const id of [...picked]) if (!list.some((c) => c.id === id && c.spendable)) picked.delete(id);
    if (!list.length) { box.appendChild(el('p', 'hint', info().test ? tr('No practice coins yet. Use the Faucet tab to get some.') : tr('No coins yet. Use Receive to get your first address.'))); return; }
    list.forEach((c) => {
      const row = el('div', 'coin');
      const cb = el('input'); cb.type = 'checkbox'; cb.disabled = !c.spendable; cb.checked = picked.has(c.id);
      cb.setAttribute('aria-label', tr('Spend this coin'));
      cb.addEventListener('change', () => { if (cb.checked) picked.add(c.id); else picked.delete(c.id); });
      const m = el('div', 'm');
      const a = el('div', 'a', btc(c.value) + ' ' + unit);
      a.appendChild(el('span', 'tag', tr(c.typeLabel)));
      if (c.spentInMempool) a.appendChild(el('span', 'tag bad', tr('being spent')));
      else if (c.immature) a.appendChild(el('span', 'tag bad', tr('immature')));
      else if (!c.confirmations) a.appendChild(el('span', 'tag', tr('unconfirmed')));
      else a.appendChild(el('span', 'tag okk', c.confirmations >= 6 ? tr('6+ conf') : tr('{n} conf', { n: c.confirmations })));
      m.appendChild(a);
      m.appendChild(el('div', 'd', (c.address || tr('bare public key (no address)')) + ' · ' + c.path));
      if (c.type === 'p2pk' && c.spendable) { const b = el('button', 'back', tr('Spend this P2PK coin')); b.type = 'button'; b.style.padding = '0'; b.addEventListener('click', () => { picked.clear(); picked.add(c.id); $('#a_send').click(); }); m.appendChild(b); }
      const d2 = el('div', 'd', `${c.height == null ? tr('not yet in a block') : tr('block {n}', { n: c.height })} · ${c.txid}:${c.vout} `);
      const link = el('a', null, tr('view ↗')); link.href = session.explorer + encodeURIComponent(c.txid); link.target = '_blank'; link.rel = 'noopener noreferrer';
      d2.appendChild(link); m.appendChild(d2);
      row.append(cb, m); box.appendChild(row);
    });
  }
  function renderActivity() {
    const box = $('#activity'), unit = info().unit; box.textContent = '';
    show(box, session.sent.length > 0); show($('#act_h'), session.sent.length > 0);
    session.sent.forEach((s) => {
      const row = el('div', 'coin'), m = el('div', 'm');
      const a = el('div', 'a', '−' + btc(s.sent + s.fee) + ' ' + unit);
      a.appendChild(el('span', 'tag ' + (s.status === 'confirmed' ? 'okk' : s.status === 'dropped' ? 'bad' : ''), s.status === 'dropped' ? tr('not in mempool') : tr(s.status)));
      m.appendChild(a); m.appendChild(el('div', 'd', tr('to {address}', { address: s.to })));
      if (s.message != null) m.appendChild(el('div', 'd', tr('message: “{text}”', { text: s.message })));
      const d2 = el('div', 'd', s.txid + ' ');
      const link = el('a', null, tr('view ↗')); link.href = s.explorer; link.target = '_blank'; link.rel = 'noopener noreferrer'; d2.appendChild(link);
      m.appendChild(d2); row.appendChild(m); box.appendChild(row);
    });
  }

  // ---- networks: one recovery phrase, a real wallet and a practice one ----
  function renderNetworks() {
    const box = $('#netlist'); box.textContent = '';
    const nets = visibleNets(), single = wallet.networks.length === 1;
    $('#net_sub').textContent = wallet.practiceOnly ? tr('A practice wallet: Testnet 4 only, nothing at stake.')
      : single ? tr('This wallet is a single private key: it exists on Bitcoin mainnet only.')
      : nets.length > 2 ? tr('One recovery phrase, {n} networks.', { n: nets.length }) : tr('One recovery phrase: real bitcoin, and a practice wallet on Testnet 4.');
    show($('#net_warn'), !wallet.practiceOnly && !single);
    show($('#net_hint'), !wallet.practiceOnly && !single);
    const SUB = { mainnet: tr('Real bitcoin · Olesia node'), testnet4: tr('Practice network · free coins from the Faucet tab'), signet: tr('Practice network · steady blocks'), testnet3: tr('Practice network · older') };
    nets.forEach((n) => {
      const inf = OM.netInfo[n];
      const row = el('button', 'netrow' + (n === net ? ' on' : '')); row.type = 'button'; row.dataset.net = n;
      row.appendChild(el('span', 'dot' + (inf.test ? '' : ' main')));
      const m = el('span', 'm'), nm = el('span', 'n', tr(inf.label));
      nm.appendChild(el('span', 'tag ' + (inf.test ? '' : 'real'), inf.test ? tr('no value') : tr('real bitcoin')));
      m.append(nm, el('span', 's', SUB[n] || ''));
      const v = el('span', 'v');
      if (wallet.opened(n) && wallet.session(n).scanned) { const sm = wallet.session(n).summary(); v.textContent = btc(sm.confirmed + sm.pendingChange); v.appendChild(el('small', null, inf.unit)); }
      else { v.textContent = '—'; v.appendChild(el('small', null, wallet.opened(n) && n === net ? tr('loading…') : tr('tap to open'))); }
      row.append(m, v);
      row.addEventListener('click', () => setNetwork(n));
      box.appendChild(row);
    });
  }

  // ---- faucet: free practice coins (the claim itself happens on the faucet's own page) ----
  let faucetNet = 'testnet4';
  function renderFaucet() {
    const nets = visibleNets().filter((n) => OM.netInfo[n].test);
    show($('#f_body'), nets.length > 0); show($('#f_none'), nets.length === 0);
    show($('#f_same'), nets.length > 0 && !wallet.practiceOnly);
    if (!nets.length) return;
    if (OM.netInfo[net].test && nets.includes(net)) faucetNet = net;
    if (!nets.includes(faucetNet)) faucetNet = nets[0];
    const seg = $('#f_nets'); seg.textContent = ''; show(seg, nets.length > 1);
    nets.forEach((n) => {
      const b = el('button', n === faucetNet ? 'on' : '', tr(OM.netInfo[n].label)); b.type = 'button'; b.dataset.net = n;
      b.addEventListener('click', () => { faucetNet = n; renderFaucet(); });
      seg.appendChild(b);
    });
    const fs = wallet.session(faucetNet), addr = fs.receive(fs.info.scriptType === 'p2pkh' ? 'p2wpkh' : fs.info.scriptType).address;   // derived locally; no lookup needed (the faucet pays bech32 addresses)
    $('#f_netname').textContent = tr(OM.netInfo[faucetNet].long);
    $('#f_addr').textContent = addr;
    $('#f_go').href = OM.faucetUrl + '?network=' + encodeURIComponent(faucetNet) + '&address=' + encodeURIComponent(addr);
    $('#f_open').textContent = tr('Open my {network} wallet', { network: tr(OM.netInfo[faucetNet].label) });
  }
  $('#f_open').addEventListener('click', () => setNetwork(faucetNet));
  $('#set_morenets').addEventListener('change', (e) => { try { localStorage.setItem(MORE_NETS_KEY, e.target.checked ? 'on' : 'off'); } catch { /* fine */ } if (!visibleNets().includes(net)) setNetwork(wallet.home); renderNetworks(); renderFaucet(); });

  // the encrypted file can be downloaded again at any time — it is only ciphertext
  $('#a_savefile').addEventListener('click', () => { if (lastFile) { download(lastFile.name, lastFile.text); toast(tr('Wallet file downloaded again.'), 'ok'); } });
  // a restored, heavily used wallet may hold coins on addresses beyond the default search window
  $('#a_deeper').addEventListener('click', () => { session.scanDeeper(); toast(tr('Searching more addresses…')); refresh(false); });

  // ---- reveal the secret: needs the wallet password; auto-hides after 60 s ----
  let hideT;
  function hideReveal() { clearTimeout(hideT); show($('#reveal_box'), false); $('#reveal_words').textContent = ''; $('#reveal_wif').textContent = ''; }
  $('#a_reveal').addEventListener('click', async () => {
    if (!$('#reveal_box').classList.contains('hide')) return hideReveal();
    const r = await withPassword(tr('Enter your wallet password'), session.info.kind === 'seed' ? tr('Needed to decrypt and show your recovery phrase. Make sure nobody can see your screen.') : tr('Needed to decrypt and show your private key. Make sure nobody can see your screen.'),
      (pw, prog) => wallet.reveal(pw, prog));
    if (!r.ok) { if (r.error) toast('✗ ' + tr(r.error.message), 'bad'); return; }
    const sec = r.value;
    if (sec.kind === 'seed') { renderWords($('#reveal_words'), sec.mnemonic); show($('#reveal_wif'), false); $('#reveal_note').textContent = (sec.hasPassphrase ? tr('This wallet also needs its passphrase (not shown).') + ' ' : '') + tr('Hides automatically in 60 seconds.'); }
    else { $('#reveal_words').textContent = ''; $('#reveal_wif').textContent = sec.wif; show($('#reveal_wif')); $('#reveal_note').textContent = tr('Hides automatically in 60 seconds.'); }
    show($('#reveal_box')); clearTimeout(hideT); hideT = setTimeout(hideReveal, 60000);
  });

  // =====================================================================================
  // RECEIVE
  // =====================================================================================
  $('#a_recv').addEventListener('click', () => {
    const sel = $('#r_type'); sel.textContent = '';
    const NAMES = info().test ? { p2wpkh: tr('SegWit (tb1q…) — recommended'), p2tr: tr('Taproot (tb1p…)'), p2pkh: tr('Legacy (m… / n…)'), p2pk: tr('P2PK — bare public key (2009 style, no address)') }
                             : { p2wpkh: tr('SegWit (bc1q…) — recommended'), p2tr: tr('Taproot (bc1p…)'), p2pkh: tr('Legacy (1…)'), p2pk: tr('P2PK — bare public key (2009 style, no address)') };
    [...session.receiveTypes(), 'p2pk'].forEach((t) => { const o = el('option', null, NAMES[t] || t); o.value = t; sel.appendChild(o); });
    sel.value = session.info.scriptType;
    show($('#r_typebox'), sel.options.length > 1);
    pane('receive'); renderReceive(session.receive(sel.value));
  });
  // the chosen type is remembered and also receives this wallet's change; P2PK is a destination only this wallet can pay
  $('#r_type').addEventListener('change', () => { const t = $('#r_type').value; if (t === 'p2pk') return renderP2pk(); session.setPref(t); renderReceive(session.receive(t)); });
  async function renderReceive(r) {
    show($('#r_addrbox')); show($('#r_pkbox'), false);
    $('#r_addr').textContent = r.address;
    $('#r_path').textContent = (r.single ? tr('This private key has one address of each type; it is reused for every payment.') : tr('{path} · address #{n}', { path: r.path, n: r.index })) + (r.type === 'p2tr' ? ' · ' + tr('Taproot: Schnorr signatures, BIP-86') : '');
    show($('#r_next'), !r.single);
    try { $('#r_qr').src = await OM.qr(r.address); } catch { $('#r_qr').removeAttribute('src'); }
  }
  // P2PK: the output is the public key itself. Nobody else can pay it (there is no address);
  // "Move coins in" pays it from this wallet's own coins — a museum piece you can own.
  let p2pkFund = null;   // { script, pubkey, index } the Send screen is paying, instead of an address
  function renderP2pk() {
    const t = session.p2pkTarget();
    show($('#r_addrbox'), false); show($('#r_pkbox'));
    $('#r_pk').textContent = t.pubkey;
    $('#r_pkpath').textContent = t.single ? tr('This private key\'s public key, as a bare P2PK output.') : tr('{path} · P2PK #{n} — a fresh key each time one is used', { path: t.path, n: t.index });
    const have = session.scanned && session.coinList().some((c) => c.spendable && c.group === 'std');
    $('#r_pkgo').disabled = !have;
    $('#r_pkmsg').textContent = have ? '' : tr('This wallet needs an ordinary coin first — P2PK can only be funded from the wallet\'s own coins.');
  }
  $('#r_pkgo').addEventListener('click', () => { p2pkFund = session.p2pkTarget(); $('#a_send').click(); });
  $('#r_next').addEventListener('click', () => renderReceive(session.nextReceive($('#r_type').value)));
  $('#r_copy').addEventListener('click', () => {
    navigator.clipboard.writeText($('#r_addr').textContent).then(() => toast(tr('Address copied'), 'ok')).catch(() => toast(tr('Could not copy — select the address and copy it manually'), 'bad'));
  });

  // =====================================================================================
  // SEND
  // =====================================================================================
  let fees = null, feeChoice = 'normal';
  $('#a_send').addEventListener('click', async () => {
    if (!session.scanned) return toast(tr('Your coins are still loading — please wait for the lookup to finish.'), 'bad');
    ['#t_to', '#t_amt', '#t_fee', '#t_note'].forEach((s) => { $(s).value = ''; }); $('#t_all').checked = false; $('#t_amt').disabled = false;
    $('#t_msg').textContent = ''; show($('#t_result'), false); noteRender();
    // paying this wallet's own P2PK output instead of an address: the destination is fixed, no sweep
    show($('#t_tobox'), !p2pkFund); show($('#t_pkbox'), !!p2pkFund); show($('#t_allrow'), !p2pkFund); show($('#t_self'), !p2pkFund);
    if (p2pkFund) { $('#t_pkkey').textContent = p2pkFund.pubkey; picked.clear(); }
    const list = session.coinList().filter((c) => c.spendable);
    const use = picked.size ? list.filter((c) => picked.has(c.id)) : (list.some((c) => c.group === 'std') ? list.filter((c) => c.group === 'std') : list);
    $('#t_avail').textContent = (picked.size ? (use.length === 1 ? tr('Spending only the 1 ticked coin') : tr('Spending only the {n} ticked coins', { n: use.length })) : tr('Available')) + `: ${btc(use.reduce((a, c) => a + c.value, 0))} ${info().unit}`;
    pane('send'); fees = undefined; renderFees();
    const forNet = net;
    try { fees = await OM.fees(forNet); } catch { fees = null; }
    if (forNet !== net) return;
    renderFees();
  });
  function renderFees() {
    const box = $('#t_fees'); box.textContent = '';
    const opts = fees ? [['slow', tr('Slow'), fees.slow], ['normal', tr('Normal'), fees.normal], ['fast', tr('Fast'), fees.fast]].filter((o) => o[2]) : [];
    if (!opts.length) { box.appendChild(el('span', 'hint', fees === null ? tr('Fee estimates unavailable — enter a rate below.') : fees === undefined ? tr('Loading fee estimates…') : '')); return; }
    if (!opts.some((o) => o[0] === feeChoice)) feeChoice = opts[0][0];
    opts.forEach(([id, name, rate]) => {
      const b = el('button', id === feeChoice && !$('#t_fee').value ? 'on' : '', `${name} · ${rate} sat/vB`); b.type = 'button';
      b.addEventListener('click', () => { feeChoice = id; $('#t_fee').value = ''; renderFees(); });
      box.appendChild(b);
    });
  }
  $('#t_fee').addEventListener('input', renderFees);
  // optional OP_RETURN message: live byte count (UTF-8 bytes, not characters)
  function noteRender() {
    const n = OM.messageBytes($('#t_note').value), c = $('#t_notecount');
    c.textContent = tr('{n} / {max} bytes', { n, max: OM.messageMax }); c.className = n > OM.messageMax ? 'bad' : '';
  }
  $('#t_note').addEventListener('input', noteRender);
  // "message only": pay yourself, so no coins leave the wallet except the network fee
  $('#t_self').addEventListener('click', () => {
    $('#t_to').value = session.receive().address;
    if (!$('#t_all').checked) { $('#t_all').checked = true; $('#t_amt').disabled = true; $('#t_amt').value = ''; }
    toast(tr('Destination set to your own address. Everything comes back to you, minus the network fee.'));
  });
  $('#t_all').addEventListener('change', () => { $('#t_amt').disabled = $('#t_all').checked; if ($('#t_all').checked) $('#t_amt').value = ''; });
  // exact decimal -> satoshi conversion (no floating point)
  function parseAmount(text, unit) {
    const s = String(text || '').trim().replace(/,/g, '');
    if (unit === 'sat') { if (!/^\d{1,16}$/.test(s)) throw new Error(tr('enter the amount as a whole number of sats')); return Number(s); }
    const m = s.match(/^(\d{0,8})(?:\.(\d{1,8}))?$/);
    if (!m || (!m[1] && !m[2])) throw new Error(tr('enter the amount in {unit}, for example 0.0005 (at most 8 decimal places)', { unit: info().unit }));
    return Number(m[1] || '0') * 100000000 + Number((m[2] || '').padEnd(8, '0'));
  }
  function currentFeeRate() {
    const custom = $('#t_fee').value.trim();
    if (custom) { if (!/^\d{1,4}$/.test(custom) || Number(custom) < 1) throw new Error(tr('fee rate must be a whole number of sat/vB, 1 or more')); return Number(custom); }
    if (fees && fees[feeChoice]) return fees[feeChoice];
    throw new Error(tr('enter a fee rate (sat/vB) — the node gave no estimate'));
  }
  let confirmResolve = null;
  function closeConfirm(v) { $('#confirm').classList.remove('on'); if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(v); } }
  $('#c_cancel').addEventListener('click', () => closeConfirm(false));
  $('#c_go').addEventListener('click', () => closeConfirm(true));
  $('#c_ack').addEventListener('change', () => { $('#c_go').disabled = !$('#c_ack').checked; });
  function confirmSheet(b) {
    const rows = $('#c_rows'); rows.textContent = '';
    const add = (k, v, sub) => { const r = el('div', 'crow'); r.appendChild(el('span', 'k', k)); const vv = el('span', 'v', v); if (sub) vv.appendChild(el('small', null, sub)); r.appendChild(vv); rows.appendChild(r); };
    const unit = info().unit;
    add(tr('Network'), tr(info().long), info().test ? tr('practice coins · no value') : tr('real bitcoin'));
    add(tr('To'), b.to || tr('this wallet\'s own P2PK output (bare public key)'), `${btc(b.sent)} ${unit} · ` + tr('{n} sats', { n: b.sent.toLocaleString('en-US') }) + (b.toScript ? ' · ' + b.toScript.slice(2, 68) : ''));
    if (b.change) add(tr('Change back to you'), b.changeAddress, `${btc(b.change)} ${unit}${b.changePath ? ' · ' + b.changePath : ''}`);
    if (b.message != null) add(tr('Message (OP_RETURN)'), '“' + b.message + '”', tr('{n} bytes · public and permanent', { n: b.messageBytes }));
    add(tr('Network fee'), tr('{n} sats', { n: b.fee.toLocaleString('en-US') }), `${b.effectiveFeeRate.toFixed(1)} sat/vB · ${b.vsize} vB`);
    add(tr('Total leaving the wallet'), `${btc(b.sent + b.fee)} ${unit}`);
    add(tr('Coins spent'), String(b.inputs.length));
    add(tr('Transaction id'), b.txid.slice(0, 20) + '…', tr('exactly these signed bytes will be sent'));
    const warns = [];
    if (b.fee > b.sent * 0.1) warns.push(tr('The fee is {pct}% of the amount being sent.', { pct: (b.fee / b.sent * 100).toFixed(1) }));
    if (b.effectiveFeeRate > 200) warns.push(tr('The fee rate ({rate} sat/vB) is unusually high.', { rate: b.effectiveFeeRate.toFixed(0) }));
    const w = $('#c_warn'); show(w, warns.length > 0); w.textContent = warns.join(' ');
    show($('#c_ackrow'), warns.length > 0); $('#c_ack').checked = false; $('#c_go').disabled = warns.length > 0;
    $('#confirm').classList.add('on');
    return new Promise((res) => { confirmResolve = res; });
  }
  $('#t_review').addEventListener('click', async () => {
    const msg = $('#t_msg'); msg.className = 'hint'; show($('#t_result'), false);
    const btn = $('#t_review');
    try {
      const to = p2pkFund ? '' : $('#t_to').value.trim();
      if (!p2pkFund && !to) throw new Error(tr('enter the address to send to'));
      if (!p2pkFund && !OM.checkAddress(to, net)) throw new Error(tr('that is not a valid {network} address', { network: tr(info().long) }));
      const sweep = !p2pkFund && $('#t_all').checked;
      const amount = sweep ? null : parseAmount($('#t_amt').value, $('#t_unit').value);
      const feeRate = currentFeeRate();
      const message = $('#t_note').value.trim() || null;
      if (message && OM.messageBytes(message) > OM.messageMax) throw new Error(tr('the message is {n} bytes — the limit is {max}', { n: OM.messageBytes(message), max: OM.messageMax }));
      btn.disabled = true;
      // The wallet is held encrypted: the password decrypts it for THIS signature only.
      // SECURITY INVARIANT: build + sign ONCE, show what the signed bytes say, then broadcast
      // those exact bytes. Nothing is re-fetched, re-selected or re-signed after confirmation.
      const args = { to, toScript: p2pkFund ? p2pkFund.script : null, amount, sweep, feeRate, coinIds: picked.size ? [...picked] : null, message };
      const sendNet = net, sendSession = session;   // a payment belongs to the network it was started on
      const r = await withPassword(tr('Enter your wallet password'), tr('Needed to sign this payment. You will see every detail before anything is sent.'), (pw, prog) => wallet.prepare(sendNet, args, pw, prog));
      if (!r.ok) { if (r.error) throw r.error; msg.textContent = tr('Cancelled — nothing was sent.'); return; }
      if (sendNet !== net) throw new Error(tr('the network was switched while signing — nothing was sent'));
      const built = r.value;
      msg.textContent = '';
      if (!(await confirmSheet(built))) { msg.textContent = tr('Cancelled — nothing was sent.'); return; }
      msg.textContent = info().test ? tr('Broadcasting…') : tr('Broadcasting through the Olesia node…');
      const res = await sendSession.broadcast(built);
      picked.clear(); msg.textContent = '';
      const box = $('#t_result'); box.textContent = '';
      box.appendChild(el('b', 'ok', tr('✓ Sent')));
      box.appendChild(el('p', 'mono', res.txid));
      const link = el('a', null, tr('View on a block explorer ↗')); link.href = res.explorer; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.appendChild(link);
      box.appendChild(el('p', 'hint', tr('It will confirm in the next blocks. Your change returns to this wallet once it confirms.')));
      show(box); ['#t_to', '#t_amt', '#t_note'].forEach((s) => { $(s).value = ''; }); noteRender(); $('#t_all').checked = false; $('#t_amt').disabled = false;
      if (p2pkFund) { p2pkFund = null; show($('#t_tobox')); show($('#t_pkbox'), false); show($('#t_allrow')); show($('#t_self')); box.appendChild(el('p', 'hint', tr('Once it confirms, the coin appears in your list as P2PK — a bare public key, exactly as the first bitcoins were held.'))); }
      renderWallet();
    } catch (e) {
      let m = tr(e.message);
      if (/coin selection failed|insufficient/i.test(e.message)) m = tr('Not enough spendable coins for that amount plus the network fee.');
      msg.className = 'hint bad'; msg.textContent = '✗ ' + m;
    } finally { btn.disabled = false; }
  });

  // =====================================================================================
  // VANITY ADDRESS
  // =====================================================================================
  // The search runs in Web Workers (OM.vanity). A found key lives in `vanityResult` only until
  // it is saved (it becomes `pending` for the normal save step) or the screen is left.
  let vType = 'p2wpkh', vAnalysis = null, vRate = null, vRun = null, vanityResult = null, vBenchP = null, vDiscardArmed = 0;
  const V = OM.vanity;
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  // Phones and tablets: a full-CPU search makes them hot, flattens the battery and pauses when
  // the screen locks. Anything beyond a few minutes is warned against and, past LONG_MOBILE,
  // needs an explicit acknowledgement before it can start.
  const isMobile = (navigator.userAgentData && navigator.userAgentData.mobile)
    || /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));   // iPadOS reports itself as a Mac
  const LONG_MOBILE = 10 * 60, LONG_DESKTOP = 10 * 60;
  function vanityOpen() {
    vanityForget();
    show($('#v_browser'), false); show($('#v_script'), false); show($('#v_server'), false);
    $('#v_text').value = ''; $('#v_ic').checked = false; vanitySetType('p2wpkh');
    if (V.script) { $('#v_sha').textContent = V.script.sha256; $('#v_size').textContent = '(' + Math.round(V.script.bytes / 1024) + ' kB)'; }
    pane('vanity'); $('#v_text').focus();
    if (!vRate && !vBenchP) {
      vBenchP = V.benchmark().then((r) => { vRate = r; vanityRender(); }).catch(() => { vRate = 0; vanityRender(); });
    }
  }
  // Wipe a found key from memory and from the page, and give the form back. Called before any
  // new search starts, on discard, after the key has been saved, and when the screen is left —
  // so a previous key can never linger under a new result.
  function vanityForget() {
    vanityResult = null; vDiscardArmed = 0;
    $('#v_wif').textContent = ''; show($('#v_wif'), false); show($('#v_wifwarn'), false); $('#v_showkey').textContent = tr('Show private key');
    $('#v_addr').textContent = ''; $('#v_found_stats').textContent = ''; $('#v_discard').textContent = tr('Discard and start over');
    show($('#v_result'), false); show($('#v_unsaved'), false);
    vanityLockForm(false);
  }
  function vanityLeave() {
    if (vRun) { vRun.stop(); vRun = null; }
    vanityForget();
  }
  // while a search runs, or a found key is still unsaved, the pattern cannot be changed
  function vanityLockForm(on) {
    $('#v_text').disabled = on; $$('#v_type button').forEach((b) => { b.disabled = on; }); $('#v_ic').disabled = on;
  }
  function vanitySetType(t) {
    vType = t;
    $$('#v_type button').forEach((b) => b.classList.toggle('on', b.dataset.type === t));
    $('#v_fixed').textContent = V.types[t].hrp;
    $('#v_text').placeholder = t === 'p2wpkh' ? 'jon' : 'Jon';
    $('#v_typehint').textContent = t === 'p2wpkh'
      ? tr('SegWit is the modern standard: lower fees, and each character is only 32× harder than the last (Legacy: 58×). Always lower-case.')
      : tr('Legacy "1…" addresses: older style, higher fees. Upper and lower case are different characters — tick "any capitalisation" to make it easier.');
    $('#v_alpha').textContent = t === 'p2wpkh'
      ? tr('Allowed: q p z r y 9 x 8 g f 2 t v d w 0 s 3 j n 5 4 k h c e 6 m u a 7 l — no b, i, o or 1.')
      : tr('Allowed: digits 1–9 and letters except 0, O, I and l. The second character is usually 2–Q (others are ~60× rarer).');
    show($('#v_icrow'), t === 'p2pkh');
    vanityRender();
  }
  function vanityRender() {
    const text = $('#v_text').value, ic = vType === 'p2pkh' && $('#v_ic').checked;
    vAnalysis = text.trim() ? V.analyze({ type: vType, text, ignoreCase: ic }) : null;
    const errs = $('#v_errors'), notes = $('#v_notes'), sugg = $('#v_sugg');
    errs.textContent = ''; notes.textContent = ''; sugg.textContent = '';
    show($('#v_choose'), false); show($('#v_okwrap'), false); show($('#v_suggwrap'), false); show(errs, false);
    if (!vAnalysis) { notes.appendChild(el('p', 'hint', tr('Type the characters you want. Short is fast; every extra character multiplies the work.'))); notes.lastChild.style.margin = '0'; return; }
    for (const n of vAnalysis.notes) { const p = el('p', 'hint', tr(n)); p.style.margin = '0 0 6px'; notes.appendChild(p); }
    if (vAnalysis.suggestions.length) {
      show($('#v_suggwrap'), true);
      for (const sg of vAnalysis.suggestions) {
        const b = el('button', null, sg.text); b.type = 'button';
        b.appendChild(el('small', null, tr(sg.why) + ' · ' + tr('1 in {n}', { n: fmtInt(sg.difficulty) })));
        b.addEventListener('click', () => {
          $('#v_text').value = sg.text.replace(/^bc1q/, '').replace(/^1/, '');
          if (sg.ignoreCase) $('#v_ic').checked = true;
          vanityRender();
        });
        sugg.appendChild(b);
      }
    }
    if (!vAnalysis.ok) { errs.textContent = vAnalysis.errors.map(tr).join(' · '); show(errs, true); return; }
    show($('#v_okwrap'), true); show($('#v_choose'), true);
    $('#v_display').textContent = vAnalysis.display + (vAnalysis.ignoreCase ? ' ' + tr('(any capitalisation)') : '');
    $('#v_diff').textContent = vAnalysis.difficultyHuman;
    const here = $('#v_est_here'), hereS = $('#v_est_here_s');
    let hereSecs = null;
    if (vRate == null) { here.textContent = tr('measuring…'); hereS.textContent = ''; }
    else if (!vRate) { here.textContent = tr('unavailable'); hereS.textContent = tr('this browser cannot run the search — use the script'); }
    else {
      const e = V.estimate(vAnalysis.difficulty, vRate * V.threads); hereSecs = e.expectedSeconds;
      here.textContent = tr(e.expected); hereS.textContent = tr('{rate} keys/s on {threads} threads', { rate: fmtInt(vRate * V.threads), threads: V.threads }) + (isMobile ? ' ' + tr('(this phone/tablet)') : '');
    }
    const cores = parseInt($('#v_cores').value, 10) || 8;
    const perThread = vRate || 50000;   // until measured, assume a typical desktop thread
    const es = V.estimate(vAnalysis.difficulty, perThread * cores);
    $('#v_est_script').textContent = tr(es.expected);
    $('#v_cmd').textContent = 'node olesia-vanity.mjs ' + vAnalysis.display + (vAnalysis.ignoreCase ? ' --ignore-case' : '');
    vanityDeviceAdvice(hereSecs);
  }
  // The device warning: explicit for phones/tablets, a nudge towards the script on long desktop runs.
  function vanityDeviceAdvice(hereSecs) {
    const box = $('#v_device'), long = hereSecs != null && hereSecs > (isMobile ? LONG_MOBILE : LONG_DESKTOP);
    box.textContent = ''; box.className = 'hide';
    if (isMobile) {
      box.className = long ? 'danger' : 'warn';
      box.appendChild(el('b', null, (long ? tr('Do not run this search on a phone.') : tr('You are on a phone or tablet.')) + ' '));
      box.appendChild(document.createTextNode(long
        ? tr('It is expected to take {time} here, with every core flat out: the phone gets hot, the battery drains in minutes, and hours of it can damage the battery — and the moment the screen locks or you switch apps, the search pauses anyway. Use a desktop or laptop with the offline script, or let the Olesia server do it.', { time: hereSecs >= 3600 ? tr(V.humanTime(hereSecs)) : tr('more than 10 minutes') })
        : tr('Searching uses every core flat out: the phone gets hot and the battery drains fast, and it pauses whenever the screen locks or you switch apps. Short patterns (a few minutes) are fine; anything longer belongs on a desktop or laptop with the offline script, or on the Olesia server.')));
    } else if (long) {
      box.className = 'note';
      box.appendChild(el('b', null, tr('This is a long search for a browser tab.') + ' '));
      box.appendChild(document.createTextNode(tr('Expected {time} here; the offline script uses all your CPU and does not need a tab kept open — it is the better tool past ten minutes.', { time: tr(V.humanTime(hereSecs)) })));
    }
    // the in-browser Start button: on a phone past the limit it needs an explicit acknowledgement
    const gate = isMobile && long;
    show($('#v_ackrow'), gate);
    if (!gate) $('#v_ack').checked = false;
    $('#v_start').disabled = gate && !$('#v_ack').checked;
    $('#v_start').textContent = gate && !$('#v_ack').checked ? tr('Too long for a phone — tick the box to run anyway') : tr('Start searching');
  }
  $('#v_ack').addEventListener('change', () => { $('#v_start').disabled = !$('#v_ack').checked; $('#v_start').textContent = $('#v_ack').checked ? tr('Start searching (I will stop it if the phone gets hot)') : tr('Too long for a phone — tick the box to run anyway'); });
  $('#w_vanity').addEventListener('click', vanityOpen);
  $('#set_vanity').addEventListener('click', vanityOpen);
  $('#v_back').addEventListener('click', () => pane(session ? 'settings' : 'welcome'));
  $$('#v_type button').forEach((b) => b.addEventListener('click', () => vanitySetType(b.dataset.type)));
  $('#v_text').addEventListener('input', vanityRender);
  $('#v_ic').addEventListener('change', vanityRender);
  $('#v_cores').addEventListener('change', vanityRender);
  $('#v_pick_script').addEventListener('click', () => { show($('#v_script'), true); show($('#v_browser'), false); show($('#v_server'), false); $('#v_script').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('#v_pick_browser').addEventListener('click', () => { show($('#v_browser'), true); show($('#v_script'), false); show($('#v_server'), false); $('#v_browser').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('#v_pick_server').addEventListener('click', async () => {
    show($('#v_server'), true); show($('#v_script'), false); show($('#v_browser'), false); $('#v_server').scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const i = await V.serverInfo();
      $('#v_srv_limit').textContent = tr('about {n} minutes of expected work at {rate} keys/s', { n: Math.round(i.maxExpectedSeconds / 60), rate: fmtInt(i.keysPerSecond) });
      const es = vAnalysis && vAnalysis.ok ? V.estimate(vAnalysis.difficulty, i.keysPerSecond) : null;
      const okHere = es && es.expectedSeconds <= i.maxExpectedSeconds;
      $('#v_srv_status').textContent = (i.queued + i.running ? tr('{n} job(s) ahead of you.', { n: i.queued + i.running }) : tr('The server is idle.')) + ' '
        + (es ? (okHere ? tr('Expected {time} for your text once it starts.', { time: tr(es.expected) }) : tr('Your text would take about {time} on the server — over its limit. Use the offline script.', { time: tr(es.expected) })) : '');
      $('#v_srv_start').disabled = !okHere;
    } catch (e) { $('#v_srv_status').textContent = tr('The server-assisted search is not available right now ({error}).', { error: tr(e.message) }); $('#v_srv_start').disabled = true; }
  });
  $('#v_srv_start').addEventListener('click', async () => {
    if (!vAnalysis || !vAnalysis.ok || vRun || vanityResult) return;
    const a = vAnalysis, t0 = Date.now();
    vanityForget();   // nothing from an earlier run may survive under the new result
    show($('#v_srv_start'), false); show($('#v_srv_running'), true);
    vanityLockForm(true);
    const paint = (v) => {
      const p = 1 - Math.exp(-(v.tried || 0) / a.difficulty);
      $('#v_srv_state').textContent = v.state === 'queued' ? tr('Queued · position {n}', { n: v.position }) : v.state === 'running' ? tr('Searching on the server') : tr(v.state);
      $('#v_srv_tried').textContent = fmtInt(v.tried || 0); $('#v_srv_rate').textContent = fmtInt(v.keysPerSecond || 0);
      $('#v_srv_elapsed').textContent = tr(V.humanTime((Date.now() - t0) / 1000)); $('#v_srv_chance').textContent = (100 * p).toFixed(1) + '%';
      $('#v_srv_bar').style.width = Math.min(100, 100 * p).toFixed(1) + '%';
    };
    try {
      vRun = V.serverStart({ type: a.type, text: a.text, ignoreCase: a.ignoreCase, onStatus: paint });
      const r = await vRun.promise;
      vanityShowResult(r, t0, a);
      show($('#v_server'), false);
      toast(tr('Vanity address found and verified. Save it as a wallet file to keep it.'), 'ok');
    } catch (e) {
      if (vRun) toast(tr('Server search: {error}', { error: tr(e.message) }), 'bad');
    } finally {
      vRun = null; show($('#v_srv_start'), true); show($('#v_srv_running'), false);
      vanityLockForm(!!vanityResult);   // the form stays locked while a found key is unsaved
    }
  });
  $('#v_srv_stop').addEventListener('click', () => { if (vRun) { const r = vRun; vRun = null; r.stop(); toast(tr('Job cancelled.')); } });
  function vanityShowResult(r, t0, a) {
    vanityResult = { wif: r.wif, address: r.address };
    $('#v_addr').textContent = '';
    const lead = r.address.slice(0, a.display.length); const b = el('b', null, lead); $('#v_addr').appendChild(b); $('#v_addr').appendChild(document.createTextNode(r.address.slice(lead.length)));
    $('#v_found_stats').textContent = tr('Found after {n} keys in {time}.', { n: fmtInt(r.tried), time: tr(V.humanTime((Date.now() - t0) / 1000)) });
    show($('#v_result'), true); show($('#v_choose'), false); show($('#v_unsaved'), true);
    vanityLockForm(true);
    $('#v_result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#v_start').addEventListener('click', async () => {
    if (!vAnalysis || !vAnalysis.ok || vRun || vanityResult) return;
    const a = vAnalysis, t0 = Date.now();
    vanityForget();   // nothing from an earlier run may survive under the new result
    show($('#v_start'), false); show($('#v_running'), true);
    vanityLockForm(true);
    const paint = (tried) => {
      const secs = (Date.now() - t0) / 1000, rate = tried / Math.max(secs, 0.5);
      const p = 1 - Math.exp(-tried / a.difficulty);
      $('#v_tried').textContent = fmtInt(tried); $('#v_rate').textContent = fmtInt(rate);
      $('#v_elapsed').textContent = tr(V.humanTime(secs)); $('#v_chance').textContent = (100 * p).toFixed(1) + '%';
      $('#v_remaining').textContent = rate > 0 ? tr(V.humanTime(a.difficulty / rate)) : '…';
      $('#v_bar').style.width = Math.min(100, 100 * p).toFixed(1) + '%';
    };
    const ticker = setInterval(() => { if (vRun) paint(vRun.tried); }, 500);
    try {
      vRun = V.start({ type: a.type, text: a.text, ignoreCase: a.ignoreCase, threads: V.threads, onProgress: paint });
      const r = await vRun.promise;
      vanityShowResult(r, t0, a);
      show($('#v_browser'), false);
      toast(tr('Vanity address found. Save it as a wallet file to keep it.'), 'ok');
    } catch (e) {
      if (vRun) toast(tr('Search failed: {error}', { error: tr(e.message) }), 'bad');
    } finally {
      clearInterval(ticker); vRun = null;
      show($('#v_start'), true); show($('#v_running'), false);
      vanityLockForm(!!vanityResult);   // the form stays locked while a found key is unsaved
    }
  });
  $('#v_stop').addEventListener('click', () => { if (vRun) { const r = vRun; vRun = null; r.stop(); toast(tr('Search stopped.')); } });
  // Save: the key becomes `pending` for the normal save step. `vanityResult` is kept until the file
  // is actually written, so "‹ Back" from the save screen returns here with the key still present
  // instead of silently losing a search that may have taken hours.
  $('#v_save').addEventListener('click', () => {
    if (!vanityResult) return;
    pending = { kind: 'wif', wif: vanityResult.wif };
    openSave('import');
  });
  $('#v_showkey').addEventListener('click', () => {
    if (!vanityResult) return;
    const on = $('#v_wif').classList.contains('hide');
    $('#v_wif').textContent = on ? vanityResult.wif : ''; show($('#v_wif'), on); show($('#v_wifwarn'), on);
    $('#v_showkey').textContent = on ? tr('Hide private key') : tr('Show private key');
  });
  $('#v_paper').addEventListener('click', () => {
    if (!vanityResult) return;
    const r = vanityResult; vanityForget();
    paperShow({ wif: r.wif, address: r.address, type: r.address.startsWith('bc1q') ? 'p2wpkh' : r.address.startsWith('bc1p') ? 'p2tr' : 'p2pkh', source: 'vanity' });
  });
  // Discard needs two clicks within a few seconds: one click must not throw away an hour of work.
  $('#v_discard').addEventListener('click', () => {
    if (!vanityResult) { vanityForget(); show($('#v_choose'), true); return; }
    if (Date.now() - vDiscardArmed > 5000) {
      vDiscardArmed = Date.now(); $('#v_discard').textContent = tr('Really discard? Click again');
      setTimeout(() => { if (vanityResult) $('#v_discard').textContent = tr('Discard and start over'); }, 5000);
      return;
    }
    vanityForget(); $('#v_text').value = ''; vanityRender(); $('#v_text').focus();
    toast(tr('Discarded — nothing was saved.'));
  });

  // =====================================================================================
  // SIGNED MESSAGES
  // =====================================================================================
  let sgLast = null;   // the last proof made: { address, message, signature, format, coreCommand }
  const ARMOUR = (a, m, sig) => `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${m}\n-----BEGIN BITCOIN SIGNATURE-----\n${a}\n${sig}\n-----END BITCOIN SIGNATURE-----`;
  function signOpen(mode) {
    sgLast = null; show($('#sg_out'), false); $('#sg_msg').value = ''; $('#sg_count').textContent = '';
    $('#vf_result').textContent = ''; show($('#vf_result'), false);
    const sel = $('#sg_addr'); sel.textContent = '';
    show($('#sg_nowallet'), !session); show($('#sg_form'), !!session);
    if (session) for (const a of session.signableAddresses()) { const o = el('option', null, `${a.address}  —  ${tr(a.typeLabel)}, ${tr(a.note)}`); o.value = a.address; sel.appendChild(o); }
    signMode(mode || (session ? 'sign' : 'verify'));
    pane('sign');
  }
  function signMode(m) {
    $$('#sg_mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    show($('#sg_sign'), m === 'sign'); show($('#sg_verify'), m === 'verify');
  }
  $('#set_sign').addEventListener('click', () => signOpen('sign'));
  $('#w_verify').addEventListener('click', () => signOpen('verify'));
  $('#sg_back').addEventListener('click', () => pane(session ? 'settings' : 'welcome'));
  $$('#sg_mode button').forEach((b) => b.addEventListener('click', () => signMode(b.dataset.mode)));
  $('#sg_msg').addEventListener('input', () => { const n = OM.messageBytes($('#sg_msg').value); $('#sg_count').textContent = n ? tr('{n} / {max} bytes', { n, max: OM.message.max }) : ''; });
  $('#sg_go').addEventListener('click', async () => {
    if (!session) return;
    const address = $('#sg_addr').value, message = $('#sg_msg').value;
    if (!message.trim()) { toast(tr('Write the message first.'), 'bad'); return; }
    if (OM.messageBytes(message) > OM.message.max) { toast(tr('The message is too long.'), 'bad'); return; }
    const r = await withPassword(tr('Enter your wallet password'), tr("Needed to sign the message with this address's key. Nothing is sent anywhere."), (pw, prog) => wallet.signMessage(net, { address, message }, pw, prog));
    if (!r.ok) { if (r.error) toast('✗ ' + tr(r.error.message), 'bad'); return; }
    sgLast = r.value;
    $('#sg_fmt').textContent = sgLast.format === 'legacy'
      ? tr('Format: the classic "Bitcoin Signed Message" — verifiable in Bitcoin Core, Electrum, Sparrow and most tools.')
      : tr('Format: BIP-322 (the standard for bc1q addresses) — verifiable in Sparrow, BlueWallet, Ledger Live and bip322 libraries. Bitcoin Core cannot verify BIP-322 yet; for a Core-verifiable proof sign with a Legacy (1…) address instead.');
    $('#sg_proof').textContent = ARMOUR(sgLast.address, sgLast.message, sgLast.signature);
    $('#sg_core').textContent = sgLast.coreCommand ? tr('A sceptic with a Bitcoin Core node can check it with: {command}', { command: sgLast.coreCommand }) : '';
    show($('#sg_out'), true); $('#sg_out').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(tr('Signed.'), 'ok');
  });
  $('#sg_copy').addEventListener('click', () => { if (sgLast) navigator.clipboard.writeText($('#sg_proof').textContent).then(() => toast(tr('Proof copied'), 'ok')).catch(() => toast(tr('Could not copy — select the text and copy it manually'), 'bad')); });
  $('#sg_selfcheck').addEventListener('click', () => {
    if (!sgLast) return;
    $('#vf_addr').value = sgLast.address; $('#vf_msg').value = sgLast.message; $('#vf_sig').value = sgLast.signature;
    signMode('verify'); $('#vf_go').click();
  });
  // Verify: a pasted armour block fills the three fields itself
  function unarmour(text) {
    const m = /-----BEGIN BITCOIN SIGNED MESSAGE-----\r?\n([\s\S]*?)\r?\n-----BEGIN BITCOIN SIGNATURE-----\r?\n(\S+)\r?\n([\s\S]*?)\r?\n-----END BITCOIN SIGNATURE-----/.exec(text);
    return m ? { message: m[1], address: m[2], signature: m[3].replace(/\s+/g, '') } : null;
  }
  $('#vf_msg').addEventListener('input', () => { const u = unarmour($('#vf_msg').value); if (u) { $('#vf_addr').value = u.address; $('#vf_msg').value = u.message; $('#vf_sig').value = u.signature; toast(tr('Signed-message block recognised and split into the fields.')); } });
  $('#vf_go').addEventListener('click', () => {
    const out = $('#vf_result'); out.textContent = ''; out.className = '';
    const r = OM.message.verify({ address: $('#vf_addr').value.trim(), message: $('#vf_msg').value, signature: $('#vf_sig').value });
    out.className = r.ok ? 'hint ok' : 'danger';
    out.textContent = r.ok ? tr('✓ Valid. The owner of {address} signed exactly this message ({format}).', { address: $('#vf_addr').value.trim(), format: r.format }) : tr('✗ Not valid: {reason}. A single changed character in the message, address or signature makes it fail — check for stray spaces or line breaks.', { reason: tr(r.reason) });
    show(out, true);
  });

  // =====================================================================================
  // PRIVACY CHECK
  // =====================================================================================
  $('#set_privacy').addEventListener('click', () => { show($('#pr_out'), false); $('#pr_status').textContent = ''; $('#pr_findings').textContent = ''; pane('privacy'); });
  $('#pr_back').addEventListener('click', () => pane('settings'));
  $('#pr_go').addEventListener('click', async () => {
    if (!session) return;
    const go = $('#pr_go'); go.disabled = true; $('#pr_status').textContent = tr('Looking at your coins…');
    try {
      let feeRate = 10; try { const f = await OM.fees(net); feeRate = Math.max(1, Math.round(f.normal || f.fast || f.slow || 10)); } catch { /* default */ }
      const r = await session.privacy({ feeRate, onProgress: (d, n) => { $('#pr_status').textContent = tr('Reading the transactions that created your coins… {d} / {n}', { d, n }); } });
      $('#pr_status').textContent = (r.coins === 1 ? tr('1 coin looked at') : tr('{n} coins looked at', { n: r.coins })) + (r.wanted ? ', ' + tr('{d} of {n} creating transactions read', { d: r.fetched, n: r.wanted }) : '') + ', ' + tr('fees judged at {rate} sat/vB.', { rate: feeRate });
      $('#pr_summary').textContent = tr(r.summary);
      const box = $('#pr_findings'); box.textContent = '';
      for (const f of r.findings) {
        const d = el('div', 'find ' + f.level);
        d.appendChild(el('span', 'lv', { high: tr('important'), medium: tr('worth fixing'), low: tr('minor'), info: tr('good to know'), good: tr('good') }[f.level]));
        d.appendChild(el('b', 't', tr(f.title))); d.appendChild(el('p', null, tr(f.detail)));
        if (f.advice) d.appendChild(el('p', 'adv', '→ ' + tr(f.advice)));
        box.appendChild(d);
      }
      show($('#pr_out'), true);
    } catch (e) { toast('✗ ' + tr(e.message), 'bad'); $('#pr_status').textContent = ''; }
    finally { go.disabled = false; }
  });

  // =====================================================================================
  // PAPER WALLET
  // =====================================================================================
  // The key lives in `paperKey` only until "Done", a save, or leaving the screen.
  let paperKey = null, ppType = 'p2wpkh';
  const paperOpen = () => { paperLeave(); show($('#pp_intro'), true); show($('#pp_sheetwrap'), false); $('#pp_offline').checked = false; $('#pp_legend2').textContent = tr(OM.paper.lookalikes); pane('paper'); };
  function paperLeave() {
    paperKey = null;
    ['#pp_sheet_addr', '#pp_sheet_wif', '#pp_checkout'].forEach((q) => { $(q).textContent = ''; });
    ['#pp_qr_addr', '#pp_qr_wif'].forEach((q) => $(q).removeAttribute('src'));
    $('#pp_check').value = ''; show($('#pp_checkout'), false);
  }
  async function paperShow({ wif, address, type, source }) {
    paperLeave();
    paperKey = { wif, address, type };
    $('#pp_sheet_type').textContent = (type === 'p2wpkh' ? tr('SegWit (bc1q)') : type === 'p2tr' ? tr('Taproot (bc1p)') : tr('Legacy (1…)')) + (source === 'vanity' ? ' · ' + tr('vanity') : '');
    $('#pp_sheet_addr').textContent = address; $('#pp_sheet_wif').textContent = wif;
    $('#pp_sheet_date').textContent = new Date().toISOString().slice(0, 10);
    $('#pp_sheet_legend').textContent = tr(OM.paper.lookalikes); $('#pp_legend2').textContent = tr(OM.paper.lookalikes);
    try { $('#pp_qr_addr').src = await OM.qr(address); $('#pp_qr_wif').src = await OM.qr(wif); } catch { /* text is on the sheet regardless */ }
    show($('#pp_intro'), false); show($('#pp_sheetwrap'), true);
    pane('paper'); $('#pp_sheetwrap').scrollIntoView({ block: 'start' });
  }
  $('#w_paper').addEventListener('click', paperOpen);
  $('#set_paper').addEventListener('click', paperOpen);
  $('#pp_back').addEventListener('click', () => pane(session ? 'settings' : 'welcome'));
  $$('#pp_type button').forEach((b) => b.addEventListener('click', () => { ppType = b.dataset.type; $$('#pp_type button').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#pp_make').addEventListener('click', () => {
    try { const w = OM.paper.create(ppType); paperShow({ wif: w.wif, address: w.address, type: w.type, source: 'fresh' }); }
    catch (e) { toast('✗ ' + tr(e.message), 'bad'); }
  });
  $('#pp_print').addEventListener('click', () => { try { window.print(); } catch { toast(tr("Printing is not available here — use your browser's Print menu."), 'bad'); } });
  $('#pp_verify').addEventListener('click', () => {
    if (!paperKey) return;
    const r = OM.paper.check({ wif: $('#pp_check').value, expectAddress: paperKey.address, type: paperKey.type });
    const out = $('#pp_checkout'); out.className = r.ok ? 'hint ok' : 'danger';
    out.textContent = r.ok ? tr('✓ The key you typed gives exactly the printed address. Tick the "read-back check" box on the sheet.') : '✗ ' + tr(r.reason) + (r.address ? ' ' + tr('(that key would control {address})', { address: r.address }) : '') + '. ' + tr('Compare character by character;') + ' ' + tr(OM.paper.lookalikes);
    show(out, true);
    if (r.ok) $('#pp_check').value = '';
  });
  $('#pp_save').addEventListener('click', () => { if (!paperKey) return; pending = { kind: 'wif', wif: paperKey.wif }; openSave('import'); });
  $('#pp_done').addEventListener('click', () => { paperLeave(); show($('#pp_sheetwrap'), false); show($('#pp_intro'), true); toast(tr('Wiped from the screen. The paper is now the only copy.'), 'ok'); });

  // ================= THE OPENING =================
  // A minute-long animated sequence shown the first time a browser opens the page: randomness,
  // the money of 1971 and 2008, the genesis block, the 21 million, your keys, Olesia. It is drawn
  // on a canvas by the code below — no video file, no image, nothing fetched — so the page stays
  // one self-contained file with one hash. Skip at any time; tap to jump a chapter ahead; Enter
  // at the end. Remembered per browser; replayable from Welcome and Settings. People who asked
  // their system for reduced motion get the final frame and the Enter button straight away.
  const INTRO_KEY = 'olesia:mainnet:opening';
  const intro = $('#intro'), canvas = $('#intro_c'), bcanvas = $('#intro_b');   // the scene, and the badger's own layer above it
  const CHAPTERS = [
    { dur: 11, k: 'I · Randomness', t: 'It begins with a number nobody can guess', p: 'A Bitcoin wallet is a secret number: 256 bits, chosen at random. There are more of them than atoms in the known universe. Olesia makes yours on your own device, and never sees it.' },
    { dur: 12, k: 'II · 1971 — 2008', t: 'Money came loose', p: 'In 1971 the dollar was cut from gold and every currency on Earth became a promise. In 2008 the promise was tested: banks fell, and the printing began.' },
    { dur: 13, k: 'III · 3 January 2009', t: 'A block with a headline inside it', p: '“The Times 03/Jan/2009 Chancellor on brink of second bailout for banks.” Satoshi Nakamoto wrote the day’s news into the first block, and the answer to 2008 was running.' },
    { dur: 12, k: 'IV · Hard money', t: '21,000,000 — and never more', p: 'New coins are issued on a schedule that halves every four years. The supply is fixed by mathematics, not by a committee. Nobody can print more. Not even Satoshi.' },
    { dur: 11, k: 'V · Self-reliance', t: 'Your keys. Your money.', p: 'No bank, no account, no permission needed. The key is made here, kept by you, and backed up in twelve or twenty-four words. With that comes the responsibility: nobody can reset it for you.' },
    { dur: 9, k: 'VI', t: 'Olesia.', p: 'A wallet you hold yourself. One page, your device, your keys.', logo: true },
  ];
  let introRaf = 0, introT = 0, introLast = 0, introCh = -1, introState = null, introOn = false;
  const introSeen = () => { try { return localStorage.getItem(INTRO_KEY) === 'seen'; } catch { return false; } };
  const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  // a small deterministic generator, so a chapter's particles are the same on every showing
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const ease = (x) => (x = Math.max(0, Math.min(1, x)), x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
  const easeOut = (x) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ORANGE = '#ff6a00', INK = '#f4f4f4', DIM = '#6f6f6f', MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace", SANS = "'IBM Plex Sans', system-ui, sans-serif";

  function introSize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = intro.clientWidth, h = intro.clientHeight, ctx = [];
    for (const c of [canvas, bcanvas]) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.push(g);
    }
    return { g: ctx[0], gb: ctx[1], W: w, H: h };
  }
  // swap the caption (fading the old one out first), then tell the scene where it may draw
  function introCaption(i, first, then) {
    const c = CHAPTERS[i], cap = $('#intro_cap');
    cap.style.opacity = '0';
    setTimeout(() => {
      if (introCh !== i) return;
      $('#intro_k').textContent = tr(c.k); $('#intro_p').textContent = tr(c.p); cap.classList.toggle('logo-cap', !!c.logo);
      const h = $('#intro_t'); h.textContent = c.logo ? c.t.replace(/\.$/, '') : tr(c.t); if (c.logo) h.appendChild(el('span', 'ldot', '.'));
      cap.style.opacity = '1';
      then();
    }, first ? 0 : 450);
    show($('#intro_enter'), i === CHAPTERS.length - 1); show($('#intro_skip'), i !== CHAPTERS.length - 1);
    show($('#intro_hint'), i !== CHAPTERS.length - 1);
  }
  // each chapter prepares its particles once (W, H known) and draws with progress p in [0, 1]
  const SCENES = [
    // I — bits rain down and settle into a 16×16 grid, which reads out as a 64-character key
    { prep(W, H, T, B) { seed = 11; const s = Math.min(28, W * 0.74 / 16, (B - T - 60) / 18.5), ox = (W - 16 * s) / 2, oy = T + 10; const bits = [];
        for (let i = 0; i < 256; i++) bits.push({ v: rnd() < 0.5 ? 0 : 1, sx: rnd() * W, sy: -rnd() * H * 0.8, tx: ox + (i % 16) * s + s / 2, ty: oy + Math.floor(i / 16) * s + s / 2, d: rnd() * 0.3 });
        const hex = []; for (let i = 0; i < 64; i++) hex.push((bits[i * 4].v * 8 + bits[i * 4 + 1].v * 4 + bits[i * 4 + 2].v * 2 + bits[i * 4 + 3].v).toString(16));
        return { bits, hex: hex.join(''), s, oy }; },
      draw(g, W, H, p, st) {
        g.font = `${Math.max(9, st.s * 0.62)}px ${MONO}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        for (const b of st.bits) {
          const q = ease((p - b.d) / 0.5), x = lerp(b.sx, b.tx, q), y = lerp(b.sy, b.ty, q);
          g.fillStyle = q >= 1 ? (b.v ? ORANGE : '#3a3a3a') : `rgba(255,255,255,${0.25 + 0.5 * q})`;
          g.fillText(String(b.v), x, y);
        }
        if (p > 0.62) {   // the number reads out, eight characters at a time
          const n = Math.min(64, Math.floor((p - 0.62) / 0.3 * 64)); const groups = [];
          for (let i = 0; i < n; i += 8) groups.push(st.hex.slice(i, Math.min(n, i + 8)));
          g.font = `${Math.min(18, W / 40)}px ${MONO}`; g.fillStyle = INK; g.textAlign = 'center';
          const y = st.oy + 16 * st.s + Math.max(28, st.s * 1.6);
          g.fillText(groups.slice(0, 4).join('  '), W / 2, y); g.fillText(groups.slice(4).join('  '), W / 2, y + 24);
        }
      } },
    // II — a timeline from 1960 to 2010 with a money-supply curve climbing away above it
    { prep(W, H, T, B) { return { x0: W * 0.12, x1: W * 0.88, y: B - 30, top: T + 20 }; },
      draw(g, W, H, p, st) {
        const X = (yr) => lerp(st.x0, st.x1, (yr - 1960) / 50), q = easeOut(p / 0.85);
        g.strokeStyle = '#444'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(st.x0, st.y); g.lineTo(lerp(st.x0, st.x1, q), st.y); g.stroke();
        g.font = `12px ${MONO}`; g.fillStyle = DIM; g.textAlign = 'center'; g.textBaseline = 'top';
        for (let yr = 1960; yr <= 2010; yr += 10) if (X(yr) <= lerp(st.x0, st.x1, q) + 1) { g.fillRect(X(yr) - 0.5, st.y - 4, 1, 8); g.fillText(String(yr), X(yr), st.y + 10); }
        // the curve: flat on gold, then away
        g.strokeStyle = ORANGE; g.lineWidth = 2.5; g.beginPath();
        for (let i = 0; i <= 200; i++) { const yr = 1960 + 50 * i / 200; if (yr > 1960 + 50 * q) break; const v = (yr < 1971 ? 0.02 * (yr - 1960) / 11 : 0.02 + Math.pow((yr - 1971) / 39, 2.2) * (yr > 2008 ? 1 + (yr - 2008) * 0.8 : 1)) / 2.7; const y = st.y - 6 - v * (st.y - st.top); i ? g.lineTo(X(yr), y) : g.moveTo(X(yr), y); }
        g.stroke();
        g.textBaseline = 'bottom'; g.font = `600 13px ${SANS}`;
        const mark = (yr, label, when) => { if (q * 50 + 1960 < yr) return; const a = easeOut((q * 50 + 1960 - yr) / 3); g.fillStyle = `rgba(255,106,0,${a})`; g.beginPath(); g.arc(X(yr), st.y, 5 + (1 - a) * 8, 0, Math.PI * 2); g.fill(); g.fillStyle = `rgba(244,244,244,${a})`; g.fillText(label, X(yr), st.y - 14 - when); };
        mark(1971, tr('gold window closed'), 0); mark(2008, tr('bailouts'), 36);
      } },
    // III — the chain grows block by block from the genesis block, which carries the headline
    //       (wide screens: one row; phones: a big genesis block with the chain underneath)
    { prep(W, H, T, B) {
        const narrow = W < 520, n = narrow ? 5 : 6;
        // the real hashes of blocks 0–5 (read from the Olesia node)
        const hs = ['000000000019d668', '00000000839a8e68', '000000006a625f06', '0000000082b50155', '000000004ebadb55', '000000009b726231'];
        if (!narrow) { const s = Math.min(150, (W * 0.84) / n - 14, B - T - 20); return { narrow, n, hs, s, s1: s, ox: (W - n * s - (n - 1) * 14) / 2, y: (T + B) / 2 - s / 2 }; }
        const s = Math.min(W * 0.78, (B - T) * 0.58), s1 = (s - 3 * 10) / 4, total = s + 24 + s1;
        return { narrow, n, hs, s, s1, ox: (W - s) / 2, y: (T + B) / 2 - total / 2 }; },
      draw(g, W, H, p, st) {
        for (let i = 0; i < st.n; i++) {
          const a = easeOut((p - i * 0.11) / 0.25); if (a <= 0) break;
          const big = i === 0, sz = big ? st.s : st.s1;
          const x = st.narrow ? (big ? st.ox : st.ox + (i - 1) * (st.s1 + 10)) : st.ox + i * (st.s + 14);
          const y = (st.narrow && !big ? st.y + st.s + 24 : st.y) + (1 - a) * 16;
          g.globalAlpha = a; g.fillStyle = big ? '#2b1a0c' : '#1a1a1a'; g.strokeStyle = big ? ORANGE : '#3a3a3a'; g.lineWidth = big ? 2 : 1.2;
          g.beginPath(); if (g.roundRect) g.roundRect(x, y, sz, sz, 8); else g.rect(x, y, sz, sz); g.fill(); g.stroke();
          g.fillStyle = DIM; g.font = `11px ${MONO}`; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText('#' + i, x + 9, y + 8);
          if (sz >= 110) { g.fillStyle = big ? '#ff8a33' : '#8f8f8f'; g.textAlign = 'right'; g.fillText(st.hs[i].slice(0, sz < 140 ? 12 : 16), x + sz - 9, y + 8); }
          if (i > 0 && a > 0.5) {   // the link to the block before
            g.strokeStyle = '#555'; g.lineWidth = 1.5; g.fillStyle = '#555'; g.beginPath();
            if (st.narrow && i === 1) { g.moveTo(st.ox + st.s1 / 2, st.y + st.s); g.lineTo(st.ox + st.s1 / 2, y); } else { g.moveTo(x - (st.narrow ? 10 : 14), y + sz / 2); g.lineTo(x, y + sz / 2); }
            g.stroke(); g.beginPath(); g.arc(st.narrow && i === 1 ? st.ox + st.s1 / 2 : x - (st.narrow ? 10 : 14), st.narrow && i === 1 ? st.y + st.s : y + sz / 2, 3, 0, Math.PI * 2); g.fill();
          }
          if (big) {   // the headline types itself into the genesis block
            const words = 'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks'.split(' '); const nw = Math.floor(easeOut((p - 0.25) / 0.6) * words.length);
            const fs = Math.max(10, Math.min(15, sz / 11)); g.fillStyle = INK; g.font = `500 ${fs}px ${MONO}`; g.textAlign = 'left';
            let line = '', ly = y + 28; const maxW = sz - 18;
            for (const w of words.slice(0, nw)) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { g.fillText(line, x + 9, ly); ly += fs * 1.35; line = w; } else line = t; }
            g.fillText(line, x + 9, ly);
          }
          g.globalAlpha = 1;
        }
      } },
    // IV — the halving staircase and the supply curve meeting the 21 million line
    { prep(W, H, T, B) { return { x0: W * 0.1, x1: W * 0.9, y0: B - 30, y1: T + 30 }; },
      draw(g, W, H, p, st) {
        const X = (yr) => lerp(st.x0, st.x1, (yr - 2009) / 36), q = easeOut(p / 0.8), until = 2009 + 36 * q;
        g.strokeStyle = '#444'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(st.x0, st.y0); g.lineTo(st.x1, st.y0); g.stroke();
        g.font = `12px ${MONO}`; g.fillStyle = DIM; g.textAlign = 'center'; g.textBaseline = 'top';
        for (let yr = 2009; yr <= 2045; yr += 4) if (yr <= until) g.fillText(String(yr), X(yr), st.y0 + 8);
        // the 21M line
        g.setLineDash([5, 5]); g.strokeStyle = '#555'; g.beginPath(); g.moveTo(st.x0, st.y1); g.lineTo(st.x1, st.y1); g.stroke(); g.setLineDash([]);
        // block reward staircase (scaled to the axis) in dim, supply in orange
        g.strokeStyle = '#8f8f8f'; g.lineWidth = 1.5; g.beginPath();
        for (let i = 0; i < 9; i++) { const a = 2009 + 4 * i, b = Math.min(until, a + 4); if (a > until) break; const y = st.y0 - (50 / Math.pow(2, i)) / 50 * (st.y0 - st.y1) * 0.5; g.moveTo(X(a), y); g.lineTo(X(b), y); if (b === a + 4 && i < 8) g.lineTo(X(b), st.y0 - (50 / Math.pow(2, i + 1)) / 50 * (st.y0 - st.y1) * 0.5); }
        g.stroke();
        g.strokeStyle = ORANGE; g.lineWidth = 2.5; g.beginPath();
        for (let i = 0; i <= 240; i++) { const yr = 2009 + 36 * i / 240; if (yr > until) break; const era = (yr - 2009) / 4, k = Math.floor(era), f = era - k; const sup = (1 - Math.pow(0.5, k)) * 21 + Math.pow(0.5, k) * 10.5 * f; const y = st.y0 - sup / 21 * (st.y0 - st.y1); i ? g.lineTo(X(yr), y) : g.moveTo(X(yr), y); }
        g.stroke();
        g.textAlign = 'right'; g.textBaseline = 'bottom'; g.font = `600 ${W < 520 ? 11 : 13}px ${SANS}`; g.fillStyle = '#8f8f8f'; g.fillText(tr('new coins per block: 50 → 25 → 12.5 → 6.25 → …'), st.x1, st.y0 - (st.y0 - st.y1) * 0.14);
        if (p > 0.55) { const a = easeOut((p - 0.55) / 0.3); g.fillStyle = `rgba(244,244,244,${a})`; g.font = `500 ${Math.min(22, W / 24)}px ${MONO}`; g.textAlign = 'right'; g.fillText('21,000,000', st.x1, st.y1 - 8); }
      } },
    // V — scattered bits gather into the outline of a key
    { prep(W, H, T, B) { seed = 43; const pts = [], cx = W / 2, cy = (T + B) / 2, s = Math.min(W * 0.42, (B - T) * 0.7);
        for (let i = 0; i < 120; i++) { const a = i / 120 * Math.PI * 2; pts.push([cx - s * 0.55 + Math.cos(a) * s * 0.3, cy + Math.sin(a) * s * 0.3]); }   // the bow
        const END = 0.82;                                                                                     // the shaft, closed at the tip
        for (let i = 0; i <= 70; i++) { const x = cx + s * (-0.25 + i / 70 * (0.25 + END)); pts.push([x, cy - s * 0.06]); pts.push([x, cy + s * 0.06]); }
        for (let i = 1; i < 8; i++) pts.push([cx + s * END, cy - s * 0.06 + i / 8 * s * 0.12]);
        for (const dx of [0.46, 0.65]) {                                                                       // two teeth hanging from the shaft
          for (let i = 1; i <= 12; i++) { pts.push([cx + s * dx, cy + s * 0.06 + i / 12 * s * 0.17]); pts.push([cx + s * (dx + 0.1), cy + s * 0.06 + i / 12 * s * 0.17]); }
          for (let i = 1; i < 7; i++) pts.push([cx + s * (dx + i / 7 * 0.1), cy + s * 0.23]);
        }
        return { ps: pts.map(([tx, ty]) => ({ tx, ty, sx: rnd() * W, sy: rnd() * H, d: rnd() * 0.25, v: rnd() < 0.5 ? '0' : '1' })) }; },
      draw(g, W, H, p, st) {
        g.font = `${Math.round(Math.max(10, Math.min(14, W / 100)))}px ${MONO}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        const glow = p > 0.8 ? 0.5 + 0.5 * Math.sin((p - 0.8) * 40) : 0;
        for (const q of st.ps) { const e = ease((p - q.d) / 0.4); const x = lerp(q.sx, q.tx, e), y = lerp(q.sy, q.ty, e); g.fillStyle = e >= 1 ? `rgba(255,${Math.round(106 + glow * 60)},0,1)` : `rgba(255,255,255,${0.2 + 0.6 * e})`; g.fillText(q.v, x, y); }
      } },
    // VI — a slow orange breath behind the name
    { prep(W, H) { return { cx: W / 2, cy: H * 0.45, r: Math.max(W, H) * 0.5 }; },
      draw(g, W, H, p, st) {
        const a = 0.12 + 0.08 * Math.sin(p * Math.PI * 3), rg = g.createRadialGradient(st.cx, st.cy, 0, st.cx, st.cy, st.r);
        rg.addColorStop(0, `rgba(255,106,0,${a})`); rg.addColorStop(1, 'rgba(255,106,0,0)'); g.fillStyle = rg; g.fillRect(0, 0, W, H);
      } },
  ];
  // The honey badger — "bitcoin is the honey badger of money": it does not care. It walks along
  // the bottom through the chapters, right to left, and stops under the name at the end. Drawn as
  // the animal is: low and long, a broad flat head with a small ear, a wide pale mantle from the
  // forehead over the back to the tail, short thick legs with claws — in Olesia orange. Local
  // units (1 = its height), facing left, (0, 0) at the ground under its nose; about 2.85 long.
  function badger(g, x, y, h, phase, moving, t) {
    g.save(); g.translate(x, y + (moving ? Math.sin(phase * 2) * 0.015 * h : Math.sin(t * 2) * 0.005 * h)); g.scale(h, h);
    const body = ORANGE, far = '#c8520a', mantle = '#efe6d6', dark = '#241305';
    const leg = (hx, ph, near) => {   // swings from the hip; three claws at the front of the foot
      const a = moving ? Math.sin(phase + ph) * 0.38 : 0;
      g.save(); g.translate(hx, -0.5); g.rotate(a);
      g.fillStyle = near ? body : far; g.beginPath(); g.moveTo(-0.1, 0); g.lineTo(0.1, 0); g.lineTo(0.1, 0.42); g.quadraticCurveTo(0.1, 0.5, 0.0, 0.5); g.lineTo(-0.16, 0.5); g.quadraticCurveTo(-0.16, 0.44, -0.1, 0.42); g.closePath(); g.fill();
      g.strokeStyle = near ? dark : '#3a1a05'; g.lineWidth = 0.02; g.lineCap = 'round'; g.beginPath(); for (const c of [-0.15, -0.1, -0.05]) { g.moveTo(c, 0.49); g.lineTo(c - 0.035, 0.52); } g.stroke();
      g.restore();
    };
    leg(0.7, Math.PI, false); leg(2.0, 0, false);
    g.fillStyle = body; g.beginPath();                                   // nose → forehead → back → rump → tail → belly → chest → chin
    g.moveTo(0, -0.6);
    g.quadraticCurveTo(0.06, -0.76, 0.28, -0.85);
    g.quadraticCurveTo(0.5, -0.95, 0.78, -0.92);
    g.quadraticCurveTo(1.35, -1.06, 1.95, -0.95);
    g.quadraticCurveTo(2.35, -0.88, 2.48, -0.72);
    g.quadraticCurveTo(2.8, -0.72, 2.86, -0.5);
    g.quadraticCurveTo(2.68, -0.42, 2.5, -0.5);
    g.quadraticCurveTo(2.25, -0.38, 1.7, -0.4);
    g.quadraticCurveTo(1.0, -0.38, 0.6, -0.46);
    g.quadraticCurveTo(0.28, -0.48, 0.1, -0.54);
    g.closePath(); g.fill();
    g.fillStyle = mantle; g.beginPath();                                 // the pale mantle: forehead to tail, soft lower edge along the flank
    g.moveTo(0.2, -0.82);
    g.quadraticCurveTo(0.5, -0.95, 0.78, -0.92); g.quadraticCurveTo(1.35, -1.06, 1.95, -0.95); g.quadraticCurveTo(2.35, -0.88, 2.48, -0.72); g.quadraticCurveTo(2.8, -0.72, 2.86, -0.5);
    g.quadraticCurveTo(2.72, -0.56, 2.56, -0.62);
    g.quadraticCurveTo(2.25, -0.7, 1.95, -0.74);
    g.quadraticCurveTo(1.35, -0.82, 0.8, -0.76);
    g.quadraticCurveTo(0.45, -0.74, 0.2, -0.82);
    g.closePath(); g.fill();
    leg(0.9, 0, true); leg(2.2, Math.PI, true);
    g.fillStyle = body; g.beginPath(); g.arc(0.55, -0.83, 0.05, 0, Math.PI * 2); g.fill();            // the small round ear
    g.fillStyle = dark; g.beginPath(); g.arc(0.24, -0.7, 0.032, 0, Math.PI * 2); g.fill();            // eye
    g.beginPath(); g.ellipse(0.02, -0.61, 0.045, 0.035, 0, 0, Math.PI * 2); g.fill();                  // nose
    g.restore();
  }
  const badgerH = (W) => Math.max(28, Math.min(52, W / 26));
  // Its own layer and its own clock: the scene below can fade, swap and re-prepare without the
  // badger ever blinking. It walks at a steady pace so as to arrive under the name as the last
  // chapter begins; if a tap jumps the story ahead it hurries to catch up rather than teleporting.
  let bx = null, bdist = 0, bground = null;
  function introBadger(gb, W, H, dt) {
    const last = CHAPTERS.length - 1, tSit = CHAPTERS.slice(0, last).reduce((a, c) => a + c.dur, 0);
    const h = badgerH(W), len = 2.86 * h, from = W + 6, to = W / 2 - len / 2;
    const target = lerp(from, to, Math.min(1, introT / tSit)), v = (from - to) / tSit;   // where the story says it should be, and its walking pace
    if (bx === null) bx = target;
    const gap = target - bx, want = Math.abs(gap), step = Math.min(want, (want > v * 0.3 ? v * 2.6 : v) * dt);
    bx += Math.sign(gap) * step; bdist += step;
    const G = Math.round($('#intro_foot').getBoundingClientRect().top) - 10;
    bground = bground === null ? G : bground + (G - bground) * Math.min(1, dt * 8);   // the ground moves a little when the Enter button appears
    gb.clearRect(0, 0, W, H);
    badger(gb, bx, bground, h, bdist / (0.12 * h), step > 0.01, introT);
  }
  function introFrame(now) {
    if (!introOn) return;
    const dt = Math.min(0.05, (now - introLast) / 1000 || 0); introLast = now; introT += dt;
    let i = 0, t = introT; while (i < CHAPTERS.length - 1 && t >= CHAPTERS[i].dur) { t -= CHAPTERS[i].dur; i++; }
    const { g, gb, W, H } = introSize();
    if (i !== introCh) {
      const first = introCh < 0; introCh = i; introState = null;
      introCaption(i, first, () => {   // the drawing lives between the (new) caption and the footer
        const T = Math.round($('#intro_cap').getBoundingClientRect().bottom) + 12, G = Math.round($('#intro_foot').getBoundingClientRect().top) - 10;   // G: the ground the badger walks on
        const B = G - badgerH(W) - 10;                                                                     // scenes stay above its strip
        introState = { T, B, G, ...SCENES[i].prep(W, H, T, B) };
      });
    }
    const p = Math.min(1, t / CHAPTERS[i].dur);
    g.fillStyle = '#0c0c0c'; g.fillRect(0, 0, W, H);
    if (introState) {
      g.globalAlpha = Math.min(1, t / 0.5) * (i === CHAPTERS.length - 1 ? 1 : Math.min(1, (CHAPTERS[i].dur - t) / 0.5));
      SCENES[i].draw(g, W, H, p, introState); g.globalAlpha = 1;
      if (i !== CHAPTERS.length - 1) { const T = introState.T, m = g.createLinearGradient(0, T - 50, 0, T + 10); m.addColorStop(0, 'rgba(12,12,12,.96)'); m.addColorStop(1, 'rgba(12,12,12,0)'); g.fillStyle = m; g.fillRect(0, 0, W, T + 10); }   // keep the words legible
    }
    introBadger(gb, W, H, dt);   // on its own layer, whatever the scene is doing
    $$('#intro_bar b').forEach((b, k) => { b.style.width = (k < i ? 100 : k === i ? p * 100 : 0) + '%'; });
    introRaf = requestAnimationFrame(introFrame);
  }
  function introReword() {
    if (!introOn || introCh < 0) return;
    const c = CHAPTERS[introCh]; $('#intro_k').textContent = tr(c.k); $('#intro_p').textContent = tr(c.p);
    const h = $('#intro_t'); h.textContent = c.logo ? c.t.replace(/\.$/, '') : tr(c.t); if (c.logo) h.appendChild(el('span', 'ldot', '.'));
  }
  function introStart() {
    introOn = true; introCh = -1; introT = 0; introLast = 0; bx = null; bdist = 0; bground = null; show(intro, true); intro.classList.remove('out');
    const bar = $('#intro_bar'); bar.textContent = ''; CHAPTERS.forEach(() => { const i = el('i'); i.appendChild(el('b')); bar.appendChild(i); });
    if (reducedMotion()) introT = CHAPTERS.reduce((s, c) => s + c.dur, 0) - CHAPTERS[CHAPTERS.length - 1].dur + 0.6;   // straight to the end
    cancelAnimationFrame(introRaf); introRaf = requestAnimationFrame(introFrame);
  }
  function introEnd() {
    if (!introOn) return;
    introOn = false; cancelAnimationFrame(introRaf);
    try { localStorage.setItem(INTRO_KEY, 'seen'); } catch { /* not persisted: it will play again next time */ }
    intro.classList.add('out'); setTimeout(() => { show(intro, false); intro.classList.remove('out'); }, 650);
  }
  // tap: a chapter ahead (the last chapter's tap is the Enter button's job)
  canvas.addEventListener('click', () => { if (!introOn) return; let i = 0, t = introT, acc = 0; while (i < CHAPTERS.length - 1 && t >= CHAPTERS[i].dur) { t -= CHAPTERS[i].dur; acc += CHAPTERS[i].dur; i++; } if (i < CHAPTERS.length - 1) introT = acc + CHAPTERS[i].dur; });
  $('#intro_skip').addEventListener('click', introEnd);
  $('#intro_enter').addEventListener('click', introEnd);
  document.addEventListener('keydown', (e) => { if (introOn && (e.key === 'Escape' || e.key === 'Enter')) introEnd(); });
  window.addEventListener('resize', () => { if (introOn) { introCh = -1; bx = null; bground = null; } });   // re-prepare the scene (and re-place the badger) for the new size
  $('#w_intro').addEventListener('click', introStart);
  $('#set_intro').addEventListener('click', introStart);
  if (!introSeen()) introStart();
  I18N.set(I18N.initial(), { save: false });   // the saved or the browser's language; English until a dictionary arrives

  // ================= THE STREET =================
  // The Olesia node watching the next block being loaded (after txstreet). An old Land Rover
  // Defender waits on the road; every transaction that reaches the node's mempool is a figure who
  // walks up and climbs in the back — dressed for the kind of coin it spends (hoodie = bc1q, coat
  // and hat = 1…, suit = 3…, visor = bc1p Taproot, gold = P2PK or a Satoshi-era coin); the faster
  // walkers paid the higher fee rate. The Defender carries the next block's number across its
  // side; when the block is mined it drives off with the block's numbers and the next one pulls
  // in. One WORLD (positions in units of the Defender's length, 0 = its parked front bumper) is
  // drawn in two VIEWS: the band along the bottom of every page (full, or a one-line ticker —
  // its own ▾ ▴ × controls; a phone always starts as the ticker) and the Street page, a bigger
  // scene with sky, skyline, the last blocks driving away, a tooltip per figure, the figures'
  // legend and live numbers. Data: GET /street on the node API every 6 s — public chain data,
  // nothing about this wallet. Reduced motion gets still pictures; nothing is drawn or fetched
  // while the tab is hidden or the opening is showing, or when neither view is open.
  const STREET_KEY = 'olesia:mainnet:street', BAND_KEY = 'olesia:mainnet:street:band';
  const street = $('#street'), stCanvas = $('#st_canvas');
  const streetWanted = () => { try { return localStorage.getItem(STREET_KEY) !== 'off'; } catch { return true; } };
  const bandSaved = () => { try { return localStorage.getItem(BAND_KEY); } catch { return null; } };
  let streetOn = streetWanted(), pageOn = false, streetRaf = 0, streetLast = 0, streetTimer = 0, streetData = null, streetErr = null, streetSeenT = 0, streetHeight = 0;
  let bandFull = null;   // the band's mode on this device: true = scene, false = ticker, null = not chosen (full on Welcome, ticker once a wallet is open; a phone starts as the ticker)
  const SAND = '#c7b88c', ROOF = '#e9e4d3', GLASS = '#182026', TYRE = '#101010', RIM = '#6d6d6d', ROAD = '#1c1c1c';
  const DOOR = 1.06, SPAWN = 4.6;   // the back door, and where new figures appear (off every view's right edge)
  const car = { x: 0, mode: 'parked', t: 0, dist: 0, bump: 9, label: null, fill: 0 };   // one vehicle: where it is (world units), what it says, what it is doing
  let punks = [];   // the figures walking up: { x, h, v (world units), ph, st ('walk' | 'wait' | 'board'), bt, sats, more, tag, a (the arrival) }
  const fmtBtc = (sats) => { const b = (sats || 0) / 1e8; const d = b >= 100 ? 1 : b >= 1 ? 2 : 4; return b.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
  const fmtN = (x) => Number(x || 0).toLocaleString('en-US');
  const fmtAmt = (sats) => (sats === null || sats === undefined ? '' : sats < 100000 ? tr('{n} sats', { n: fmtN(sats) }) : fmtBtc(sats) + ' ₿');   // small ones in sats, so dust reads as dust rather than 0.0000
  const fiatShort = (sats) => { const q = quotes && quotes[cur]; if (!q) return ''; const v = (sats || 0) / 1e8 * q.price, c = CUR[cur]; return v >= 1e9 ? c + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? c + (v / 1e6).toFixed(1) + 'M' : v >= 1e4 ? c + Math.round(v / 1e3) + 'k' : c + v.toLocaleString('en-US', { maximumFractionDigits: 0 }); };
  const isPhone = () => window.innerWidth < 700;
  const bandIsFull = () => (isPhone() ? bandFull === true : bandFull === null ? !session : bandFull);
  const ago = (sec) => (sec < 60 ? tr('{n} s ago', { n: Math.max(0, Math.round(sec)) }) : sec < 3600 ? tr('{n} min ago', { n: Math.round(sec / 60) }) : tr('{h} h {m} min ago', { h: Math.floor(sec / 3600), m: Math.round(sec % 3600 / 60) }));
  const dur = (sec) => (sec < 60 ? tr('{n} s', { n: Math.round(sec) }) : tr('{n} min', { n: Math.round(sec / 60) }));
  const active = () => streetOn || pageOn;

  // ---- the two views: each sizes its canvas and says where the world sits on it ----
  function sizeCanvas(c) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, W, H };
  }
  function bandLayout() {
    const { g, W, H } = sizeCanvas(street);
    const bar = $('#tabbar'), tab = bar.classList.contains('hide') ? 0 : bar.offsetHeight, phone = isPhone(), ticker = !bandIsFull();
    const top = phone && !ticker ? 30 : 0;                                                   // a phone's open scene keeps the ticker line above it
    const base = (ticker ? 30 : phone ? 30 + 150 : Math.max(170, Math.min(250, window.innerHeight * 0.26))) + tab;   // the tab bar, when shown, must not eat the road
    if (Math.abs(H - base) > 1) { street.style.height = base + 'px'; document.body.style.setProperty('--street-h', base + 'px'); if (street.clientHeight) return bandLayout(); }   // the page scrolls above the band, never over it (a hidden band measures 0: use the numbers as they are)
    const Hh = street.clientHeight ? H : base, Y = Hh - tab - 8, L = Math.max(120, Math.min(230, W * 0.17, (Y - top - 10) / 0.97));   // the ground, and the Defender's length (it must fit the band)
    return { g, W, H: Hh, Y, L, tab, ticker, top, phone, park: phone ? W * 0.5 - L / 2 : Math.max(340, W * 0.42), kind: 'band' };
  }
  function pageLayout() {
    const { g, W, H } = sizeCanvas(stCanvas);
    const L = Math.max(90, Math.min(330, W / 5.2, H / 1.9)), Y = H - Math.max(26, H * 0.14);
    return { g, W, H, Y, L, park: W * 0.4, kind: 'page', phone: isPhone(), ticker: false, tab: 0, top: 0 };
  }
  function streetSet(on) {
    streetOn = on; try { localStorage.setItem(STREET_KEY, on ? 'on' : 'off'); } catch { /* fine */ }
    show(street, on); document.body.classList.toggle('street', on); $('#set_street').checked = on; $('#st_band').checked = on; $('#w_street').textContent = on ? tr('Hide the street') : tr('Show the street');
    if (on) { streetPoll(); streetTick(); } else { document.body.style.removeProperty('--street-h'); if (!pageOn) { clearTimeout(streetTimer); cancelAnimationFrame(streetRaf); } }
  }
  function bandMode(full) { bandFull = full; try { localStorage.setItem(BAND_KEY, full ? 'full' : 'ticker'); } catch { /* fine */ } streetLast = 0; }
  function streetPaneOpen() { pageOn = true; legendRender(); streetStats(); streetPoll(); streetTick(); }
  function streetPaneClose() { if (!pageOn) return; pageOn = false; $('#st_tip').classList.add('hide'); if (!streetOn) { clearTimeout(streetTimer); cancelAnimationFrame(streetRaf); } }
  // ---- data ----
  async function streetPoll() {
    clearTimeout(streetTimer);
    if (!active()) return;
    if (document.hidden || introOn) { streetTimer = setTimeout(streetPoll, 2000); return; }
    let wait = 6000;
    try {
      const d = await OM.street();
      if (!d || !d.tip) throw new Error('no data');
      streetErr = null;
      const first = !streetData; streetData = d;
      if (first) { streetHeight = d.tip.height; streetSeenT = d.at; car.label = nextLabel(d); car.fill = d.next.weight / 4e6; }
      else if (d.tip.height > streetHeight && car.mode === 'parked') {   // the block is mined: it leaves with the block's numbers on its side
        streetHeight = d.tip.height; car.label = { height: d.tip.height, txs: d.tip.txs, sats: d.tip.sats, mined: true }; car.fill = 1; car.mode = 'leaving'; car.t = 0;
      } else if (car.mode === 'parked') { car.label = nextLabel(d); car.fill = d.next.weight / 4e6; }
      // figures already walking learn their value once the node has read it
      for (const p of punks) if (p.sats === null || p.sats === undefined) { const a = (d.arrivals || []).find((x) => x.txid === p.txid); if (a && a.sats !== null && a.sats !== undefined) { p.sats = a.sats; p.a = a; } }
      // the newest arrivals become figures (at most 8 per poll; the last one carries the overflow)
      const fresh = (d.arrivals || []).filter((a) => a.t > streetSeenT).sort((a, b) => a.t - b.t);
      if (fresh.length) streetSeenT = fresh[fresh.length - 1].t;
      if (!reducedMotion()) {
        const room = Math.max(0, 14 - punks.length), take = fresh.slice(0, Math.min(8, room));
        take.forEach((a, i) => punks.push(newPunk(a, i, i === take.length - 1 ? fresh.length - take.length : 0)));
      }
      if (pageOn) streetStats();
    } catch (e) { streetErr = e.message; wait = 30000; if (pageOn) streetStats(); }
    streetTimer = setTimeout(streetPoll, wait);
  }
  const nextLabel = (d) => ({ height: d.tip.height + 1, txs: d.next.txs, sats: d.next.sats, mined: false });
  // ---- the figures: families, one per kind of coin spent, each with its own wardrobe ----
  const FAMILIES = {
    p2wpkh: { tag: 'bc1q', name: 'Native SegWit', about: 'The everyday coin since 2017: a bc1q… address (pay-to-witness-public-key-hash). Small and cheap. Hoodies, laptops, phones — the working crowd of the network.', tops: ['#262626', '#1f2a22', '#241f33', '#1d2630', '#2a2420'], hats: ['hood', 'hood', 'beanie', 'cap'], items: ['laptop', 'laptop', 'phone', 'backpack', 'none'] },
    p2wsh: { tag: 'bc1q script', name: 'SegWit script', about: 'A bc1q… address that hides a script rather than one key — multisig vaults, Lightning channels, exchanges. Headphones and backpacks: the builders.', tops: ['#1b3a3a', '#19332c', '#223'], hats: ['headphones', 'beanie', 'none'], items: ['backpack', 'laptop'] },
    p2sh: { tag: '3…', name: 'Script (P2SH)', about: 'A 3… address: pay-to-script-hash, the 2012 way to lock coins to a script (often multisig). Suits and briefcases — the institutional look.', tops: ['#1c2233', '#222', '#2b2b33', '#1a1a1a'], hats: ['none', 'slick'], items: ['briefcase', 'briefcase', 'phone', 'none'], suit: true },
    'p2sh-p2wpkh': { tag: '3… wrapped', name: 'Wrapped SegWit', about: 'A 3… address with SegWit inside: the compatibility format of 2017–2020, still common in older wallets and exchanges. A suit carrying a laptop.', tops: ['#1c2233', '#2b2b33'], hats: ['none', 'slick'], items: ['laptop', 'briefcase'], suit: true },
    'p2sh-p2wsh': { tag: '3… wrapped', name: 'Wrapped SegWit script', about: 'A 3… address wrapping a SegWit script — multisig for wallets that never learned bech32.', tops: ['#1c2233', '#222'], hats: ['none'], items: ['briefcase'], suit: true },
    p2pkh: { tag: '1… legacy', name: 'Legacy', about: 'The original 1… address (pay-to-public-key-hash), 2009–2017: bigger transactions, higher fees. Long coats, fedoras and canes — the old guard.', tops: ['#4a3728', '#3b3a2f', '#2f2a26', '#44382c'], hats: ['fedora', 'fedora', 'flatcap'], items: ['none', 'briefcase', 'cane'], coat: true, beard: 0.7 },
    p2tr: { tag: 'bc1p taproot', name: 'Taproot', about: 'A bc1p… address (2021): Schnorr signatures, one key or a whole tree of scripts behind the same-looking output. Neon visors, mohawks, skateboards — the new wave.', tops: ['#2a1f44', '#1f3344', '#3a1f3f'], hats: ['visor', 'visor', 'mohawk'], items: ['phone', 'none', 'skate'], neon: ['#b388ff', '#4fd1c5', '#ff6a00'] },
    p2pk: { tag: 'P2PK · Satoshi', name: 'Bare public key (P2PK)', about: 'No address at all: the coin is locked to the public key itself, as in the genesis block and the first years of mining. Gold, after the Satoshi statue in Budapest. This wallet can make one: Receive → P2PK.', tops: ['#c9961a'], hats: ['hood'], items: ['none'], gold: true },
    satoshi: { tag: 'Satoshi era', name: 'Satoshi-era coin', about: 'A coin created before block 100,000 (2009–2010) is moving. Rare: most of them have never moved. Gold, like the statue.', tops: ['#c9961a'], hats: ['hood'], items: ['none'], gold: true },   // tags are translated when a figure is made
    other: { tag: '', name: 'Other', about: 'Something unusual: a non-standard or multi-type spend.', tops: ['#333', '#3a3a3a'], hats: ['cap', 'none'], items: ['none', 'phone'] },
  };
  const FAM_ORDER = ['satoshi', 'p2pk', 'p2tr', 'p2wsh', 'p2sh-p2wsh', 'p2sh-p2wpkh', 'p2sh', 'p2pkh', 'p2wpkh', 'other'];
  const LEGEND = ['p2wpkh', 'p2tr', 'p2pkh', 'p2sh', 'p2sh-p2wpkh', 'p2wsh', 'p2pk', 'satoshi'];
  function familyOf(a) {
    if (a.era !== null && a.era !== undefined && a.era < 100000) return 'satoshi';   // a coin created in 2009–2010
    const kinds = a.kinds || [];
    for (const f of FAM_ORDER) if (kinds.includes(f)) return f;
    return kinds.length ? 'other' : 'p2wpkh';
  }
  function wardrobe(famName, seed) {
    const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, pick = (arr) => arr[Math.floor(r() * arr.length)];
    const f = FAMILIES[famName];
    return { fam: famName, top: pick(f.tops), bottom: pick(['#1a1a1a', '#23262b', '#2a2622']), hat: pick(f.hats), item: pick(f.items), hair: pick(['#111', '#2b1d12', '#5a4632', '#777']),
      glasses: f.gold ? 'none' : r() < 0.4 ? 'shades' : r() < 0.3 ? 'round' : 'none', mask: !f.gold && !f.suit && !f.coat && r() < 0.3, beard: r() < (f.beard || 0.15), tie: f.suit ? pick(['#ff6a00', '#8a2b2b', '#777', '#2f5d8a']) : null,
      coat: !!f.coat, suit: !!f.suit, gold: !!f.gold, neon: f.neon ? pick(f.neon) : null, r };
  }
  function newPunk(a, i, more) {
    const famName = familyOf(a), s = wardrobe(famName, ((a.t | 0) ^ (a.vsize * 2654435761)) >>> 0), r = s.r;
    const tag = famName === 'satoshi' ? tr('block {n} coin', { n: fmtN(a.era) }) : tr(FAMILIES[famName].tag);
    const v = 0.42 + 0.3 * Math.min(1, Math.log10(1 + (a.rate || 1)) / 2);   // the fee rate sets the pace: a higher rate walks faster
    return { x: SPAWN + i * 0.42, h: 0.46 + r() * 0.06, v: v + r() * 0.03, ph: r() * 6, st: 'walk', bt: 0, sats: a.sats, more, s, tag, txid: a.txid, a };
  }
  // one figure, facing left, in local units (1 = its height), (0, 0) between its feet
  function punk(g, x, y, h, ph, s, walking, alpha = 1) {
    g.save(); g.globalAlpha = alpha; g.translate(x, y); g.scale(h, h);
    const sw = walking ? Math.sin(ph) : 0, bob = walking ? Math.abs(Math.cos(ph)) * 0.02 : 0, skin = s.gold ? '#e2b84a' : '#c99a6b';
    const top = s.gold ? '#c9961a' : s.top, dark = s.gold ? '#8a6410' : '#0d0d0d';
    g.lineCap = 'round';
    // legs and shoes
    g.strokeStyle = s.gold ? '#a87c14' : s.bottom; g.lineWidth = 0.085;
    g.beginPath(); g.moveTo(0.03, -0.42); g.lineTo(0.03 - sw * 0.15, -0.03); g.moveTo(-0.03, -0.42); g.lineTo(-0.03 + sw * 0.15, -0.03); g.stroke();
    g.fillStyle = s.gold ? '#8a6410' : '#111'; g.fillRect(0.03 - sw * 0.15 - 0.08, -0.04, 0.12, 0.04); g.fillRect(-0.03 + sw * 0.15 - 0.08, -0.04, 0.12, 0.04);
    g.translate(0, -bob);
    // backpack sits behind the torso
    if (s.item === 'backpack') { g.fillStyle = '#3a3a3a'; g.fillRect(0.1, -0.74, 0.14, 0.28); g.fillStyle = s.neon || ORANGE; g.fillRect(0.12, -0.7, 0.1, 0.02); }
    // torso: hoodie / jacket, a long coat, or a suit with shirt and tie
    g.fillStyle = top; g.beginPath();
    if (s.coat) { g.moveTo(-0.17, -0.22); g.lineTo(0.17, -0.22); g.lineTo(0.13, -0.76); g.lineTo(-0.13, -0.76); } else { g.moveTo(-0.15, -0.4); g.lineTo(0.15, -0.4); g.lineTo(0.13, -0.76); g.lineTo(-0.13, -0.76); }
    g.closePath(); g.fill();
    if (s.suit) { g.fillStyle = '#eee'; g.beginPath(); g.moveTo(-0.05, -0.76); g.lineTo(0.05, -0.76); g.lineTo(0, -0.58); g.closePath(); g.fill(); g.fillStyle = s.tie; g.fillRect(-0.015, -0.72, 0.03, 0.17); }
    else if (s.coat) { g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 0.015; g.beginPath(); g.moveTo(0, -0.74); g.lineTo(0, -0.24); g.moveTo(-0.08, -0.76); g.lineTo(-0.02, -0.62); g.moveTo(0.08, -0.76); g.lineTo(0.02, -0.62); g.stroke(); }
    else { g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 0.02; g.beginPath(); g.moveTo(-0.1, -0.5); g.lineTo(0.1, -0.5); g.stroke(); }   // the pocket
    if (s.neon && s.fam === 'p2tr') { g.strokeStyle = s.neon; g.lineWidth = 0.018; g.beginPath(); g.moveTo(-0.13, -0.74); g.lineTo(-0.15, -0.42); g.moveTo(0.13, -0.74); g.lineTo(0.15, -0.42); g.stroke(); }
    // the front arm, swinging against the legs, holding whatever it carries
    const ax = -0.13, ay = -0.72, hx = ax - 0.02 + sw * 0.1, hy = -0.46;
    g.strokeStyle = top; g.lineWidth = 0.075; g.beginPath(); g.moveTo(ax, ay); g.lineTo(hx, hy); g.stroke();
    g.fillStyle = skin; g.beginPath(); g.arc(hx, hy, 0.035, 0, Math.PI * 2); g.fill();
    if (s.item === 'laptop') { g.fillStyle = '#2a2a2a'; g.fillRect(hx - 0.1, hy - 0.2, 0.16, 0.11); g.fillStyle = ORANGE; g.fillRect(hx + 0.02, hy - 0.17, 0.025, 0.025); }
    if (s.item === 'briefcase') { g.fillStyle = '#3b2a1a'; g.fillRect(hx - 0.1, hy + 0.02, 0.17, 0.13); g.fillStyle = '#9a7b4f'; g.fillRect(hx - 0.03, hy + 0.0, 0.04, 0.02); }
    if (s.item === 'phone') { g.fillStyle = '#111'; g.fillRect(hx - 0.06, hy - 0.08, 0.05, 0.09); g.fillStyle = s.neon || '#7fd4ff'; g.fillRect(hx - 0.055, hy - 0.075, 0.04, 0.075); }
    if (s.item === 'cane') { g.strokeStyle = '#6b4a2b'; g.lineWidth = 0.02; g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx - 0.02, -0.02); g.stroke(); }
    if (s.item === 'skate') { g.fillStyle = '#333'; g.fillRect(hx - 0.14, hy - 0.26, 0.07, 0.42); }
    // head
    g.fillStyle = skin; g.beginPath(); g.arc(0, -0.87, 0.11, 0, Math.PI * 2); g.fill();
    if (s.gold) { const m = g.createLinearGradient(-0.1, -0.95, 0.06, -0.8); m.addColorStop(0, '#fff3c4'); m.addColorStop(0.5, '#e2b84a'); m.addColorStop(1, '#8a6410'); g.fillStyle = m; g.beginPath(); g.arc(0, -0.87, 0.1, 0, Math.PI * 2); g.fill(); }   // the mirrored face of the statue
    else { g.fillStyle = '#0d0d0d'; g.beginPath(); g.ellipse(-0.045, -0.865, 0.06, 0.08, 0, 0, Math.PI * 2); g.fill(); g.fillStyle = skin; g.beginPath(); g.ellipse(-0.06, -0.87, 0.045, 0.06, 0, 0, Math.PI * 2); g.fill(); }   // the face, a little in shadow
    if (s.beard && !s.gold) { g.fillStyle = s.hair; g.beginPath(); g.arc(-0.02, -0.82, 0.095, 0.1, Math.PI - 0.1); g.closePath(); g.fill(); }
    if (s.mask) { g.fillStyle = '#3a3a3a'; g.fillRect(-0.12, -0.86, 0.11, 0.06); }
    if (s.glasses === 'shades') { g.fillStyle = '#000'; g.fillRect(-0.13, -0.91, 0.11, 0.035); g.fillStyle = 'rgba(255,106,0,.7)'; g.fillRect(-0.12, -0.905, 0.03, 0.02); }
    if (s.glasses === 'round') { g.strokeStyle = '#ddd'; g.lineWidth = 0.012; g.beginPath(); g.arc(-0.09, -0.89, 0.028, 0, Math.PI * 2); g.moveTo(-0.0, -0.89); g.arc(-0.03, -0.89, 0.028, 0, Math.PI * 2); g.stroke(); }
    // hats and hair
    const hat = s.hat;
    if (hat === 'hood') { g.fillStyle = top; g.beginPath(); g.arc(0.01, -0.88, 0.145, Math.PI * 0.62, Math.PI * 2.38); g.lineTo(0.12, -0.74); g.lineTo(-0.1, -0.74); g.closePath(); g.fill(); g.beginPath(); g.moveTo(0.08, -1.0); g.lineTo(0.15, -1.03); g.lineTo(0.13, -0.92); g.closePath(); g.fill(); }
    else if (hat === 'beanie') { g.fillStyle = s.neon || '#444'; g.beginPath(); g.arc(0, -0.9, 0.12, Math.PI, 0); g.closePath(); g.fill(); g.fillRect(-0.12, -0.92, 0.24, 0.04); }
    else if (hat === 'cap') { g.fillStyle = '#333'; g.beginPath(); g.arc(0, -0.9, 0.115, Math.PI, 0); g.closePath(); g.fill(); g.fillRect(-0.22, -0.91, 0.22, 0.025); }
    else if (hat === 'fedora') { g.fillStyle = '#1e1a16'; g.fillRect(-0.2, -0.96, 0.4, 0.03); g.fillRect(-0.12, -1.08, 0.24, 0.13); g.fillStyle = '#5a3c20'; g.fillRect(-0.12, -0.99, 0.24, 0.025); }
    else if (hat === 'flatcap') { g.fillStyle = '#3b3328'; g.beginPath(); g.arc(0.01, -0.92, 0.12, Math.PI, 0); g.closePath(); g.fill(); g.fillRect(-0.18, -0.93, 0.2, 0.02); }
    else if (hat === 'visor') { g.fillStyle = '#111'; g.fillRect(-0.14, -0.93, 0.2, 0.05); g.fillStyle = s.neon; g.fillRect(-0.13, -0.92, 0.18, 0.03); g.fillStyle = s.hair; g.beginPath(); g.arc(0, -0.9, 0.11, Math.PI, 0); g.closePath(); g.fill(); }
    else if (hat === 'mohawk') { g.fillStyle = s.neon; for (let i = 0; i < 4; i++) g.fillRect(-0.06 + i * 0.04, -1.08 + i * 0.01, 0.025, 0.14); }
    else if (hat === 'headphones') { g.fillStyle = s.hair; g.beginPath(); g.arc(0, -0.9, 0.11, Math.PI, 0); g.closePath(); g.fill(); g.strokeStyle = '#ddd'; g.lineWidth = 0.02; g.beginPath(); g.arc(0, -0.88, 0.13, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); g.fillStyle = '#ddd'; g.fillRect(-0.15, -0.9, 0.04, 0.06); g.fillRect(0.11, -0.9, 0.04, 0.06); }
    else if (hat === 'slick') { g.fillStyle = s.hair; g.beginPath(); g.arc(0.01, -0.9, 0.11, Math.PI * 1.05, Math.PI * 1.95); g.closePath(); g.fill(); }
    else { g.fillStyle = s.hair; g.beginPath(); g.arc(0, -0.9, 0.11, Math.PI, 0); g.closePath(); g.fill(); }
    g.restore();
  }
  // ---- the Defender, in local units (1 = its length), facing left, (0, 0) on the ground under the front bumper ----
  function defender(g, x, y, L, { fill, label, wheel, alpha = 1, scale = 1, lights = false }) {
    g.save(); g.globalAlpha = alpha; g.translate(x, y); g.scale(L * scale, L * scale);
    g.lineJoin = 'round';
    for (const wx of [0.19, 0.8]) {                                                                   // wheels behind the body
      g.fillStyle = TYRE; g.beginPath(); g.arc(wx, -0.12, 0.12, 0, Math.PI * 2); g.fill();
      g.fillStyle = RIM; g.beginPath(); g.arc(wx, -0.12, 0.065, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#3a3a3a'; g.lineWidth = 0.013; g.beginPath();
      for (let k = 0; k < 5; k++) { const a = wheel + k * Math.PI * 2 / 5; g.moveTo(wx, -0.12); g.lineTo(wx + Math.cos(a) * 0.06, -0.12 + Math.sin(a) * 0.06); }
      g.stroke(); g.fillStyle = '#222'; g.beginPath(); g.arc(wx, -0.12, 0.018, 0, Math.PI * 2); g.fill();
    }
    // body: the long flat bonnet, the tall square cab and back
    g.fillStyle = SAND; g.beginPath();
    g.moveTo(0.01, -0.19); g.lineTo(0.01, -0.5); g.lineTo(0.42, -0.5); g.lineTo(0.45, -0.52); g.lineTo(0.48, -0.78); g.lineTo(0.98, -0.78); g.lineTo(0.985, -0.19); g.closePath(); g.fill();
    g.fillStyle = ROOF; g.fillRect(0.47, -0.81, 0.515, 0.04);                                         // the white roof
    g.strokeStyle = '#8f8468'; g.lineWidth = 0.011; g.beginPath(); g.moveTo(0.42, -0.5); g.lineTo(0.42, -0.21); g.moveTo(0.46, -0.52); g.lineTo(0.985, -0.52);   // the bonnet's edge, the belt line
    for (const sx of [0.6, 0.78]) { g.moveTo(sx, -0.76); g.lineTo(sx, -0.52); g.moveTo(sx, -0.31); g.lineTo(sx, -0.21); } g.stroke();   // door seams, leaving the band for the block number
    g.fillStyle = '#8f8468'; g.fillRect(0.62, -0.47, 0.04, 0.012);                                     // handle
    // windows: dark glass that lights up, from the back forward, as the block fills
    const wins = [[0.485, 0.58, true], [0.605, 0.765, false], [0.785, 0.965, false]];
    wins.forEach(([a, b, screen], i) => {
      const lit = Math.max(0, Math.min(1, fill * 3 - (2 - i)));
      g.fillStyle = GLASS; g.beginPath();
      if (screen) { g.moveTo(a + 0.025, -0.74); g.lineTo(b, -0.74); g.lineTo(b, -0.55); g.lineTo(a, -0.55); } else g.rect(a, -0.74, b - a, 0.19);
      g.closePath(); g.fill();
      if (lit > 0) { g.fillStyle = `rgba(255,140,40,${0.2 + 0.55 * lit})`; g.fill(); }
    });
    // wheel arches, grille, bumpers, headlight, the spare on the back door
    g.fillStyle = TYRE; for (const wx of [0.19, 0.8]) { g.beginPath(); g.arc(wx, -0.17, 0.15, Math.PI, 0); g.lineTo(wx + 0.15, -0.17); g.closePath(); g.fill(); }
    g.fillStyle = SAND; g.fillRect(0.01, -0.5, 0.05, 0.2); g.fillStyle = '#1a1a1a'; g.fillRect(0.0, -0.46, 0.04, 0.14);
    g.fillStyle = '#9a9a9a'; g.fillRect(-0.03, -0.22, 0.3, 0.035); g.fillRect(0.92, -0.22, 0.1, 0.035);
    g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(0.055, -0.4, 0.028, 0, Math.PI * 2); g.fill();
    if (lights) { const hl = g.createLinearGradient(0.05, -0.4, -0.5, -0.3); hl.addColorStop(0, 'rgba(255,233,168,.45)'); hl.addColorStop(1, 'rgba(255,233,168,0)'); g.fillStyle = hl; g.beginPath(); g.moveTo(0.05, -0.43); g.lineTo(-0.55, -0.6); g.lineTo(-0.55, -0.1); g.lineTo(0.05, -0.37); g.closePath(); g.fill(); g.fillStyle = '#ff3b3b'; g.fillRect(0.975, -0.46, 0.02, 0.05); }   // headlight beam and tail light at night
    g.fillStyle = TYRE; g.beginPath(); g.ellipse(1.0, -0.56, 0.028, 0.1, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = RIM; g.beginPath(); g.ellipse(1.0, -0.56, 0.011, 0.045, 0, 0, Math.PI * 2); g.fill();
    // roof rack with the load — one crate per seventh of a block
    g.strokeStyle = '#555'; g.lineWidth = 0.013; g.beginPath(); g.moveTo(0.5, -0.88); g.lineTo(0.97, -0.88);
    for (const rx of [0.52, 0.74, 0.95]) { g.moveTo(rx, -0.88); g.lineTo(rx, -0.81); } g.stroke();
    const crates = Math.min(7, Math.floor(fill * 7 + 1e-9));
    for (let i = 0; i < crates; i++) { g.fillStyle = i % 2 ? '#d9661a' : ORANGE; g.fillRect(0.535 + i * 0.058, -0.935, 0.052, 0.05); }
    if (label) {   // BLOCK and its number, large, across the whole side (the count and value are on the panel)
      const k = L * scale, txt = (str, ux, uy, size, color, align, weight = 700) => { g.save(); g.scale(1 / k, 1 / k); g.fillStyle = color; g.font = `${weight} ${Math.max(6, Math.round(size * k))}px ${MONO}`; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(str, ux * k, uy * k); g.restore(); };   // text in real pixels
      const ink = label.mined ? '#9a2f00' : '#2b2518';
      txt(tr('BLOCK'), 0.5, -0.455, 0.075, ink, 'center');
      txt(fmtN(label.height), 0.5, -0.37, 0.095, ink, 'center');
    }
    g.restore();
  }
  // ---- the world moves once per frame; each open view draws it ----
  function streetStep(dt, still) {
    if (still) { car.x = 0; return; }
    car.t += dt; car.bump += dt;
    const d = streetData;
    if (car.mode === 'parked') car.x = 0;
    else if (car.mode === 'leaving') { const q = Math.min(1, car.t / 3.4), e = q * q; const nx = -e * 4.4; car.dist += car.x - nx; car.x = nx; if (q >= 1) { car.mode = 'arriving'; car.t = 0; if (d) { car.label = nextLabel(d); car.fill = d.next.weight / 4e6; } } }
    else if (car.mode === 'arriving') { const q = Math.min(1, car.t / 2.2), e = 1 - Math.pow(1 - q, 3); const nx = SPAWN - e * SPAWN; car.dist += car.x - nx; car.x = nx; if (q >= 1) { car.mode = 'parked'; car.bump = 0; } }
    // the figures: walk to the back door, wait if the Defender is away, climb in
    for (const p of punks) {
      p.ph += dt * 9 * (p.st === 'walk' ? 1 : 0);
      if (p.st === 'walk') { if (car.mode !== 'parked' && p.x <= DOOR + 0.03) { p.st = 'wait'; continue; } p.x -= p.v * dt; if (p.x <= DOOR) { p.x = DOOR; p.st = 'board'; p.bt = 0; car.bump = 0; } }
      else if (p.st === 'wait') { if (car.mode === 'parked') p.st = 'walk'; }
      else { p.bt += dt; }
    }
    punks = punks.filter((p) => p.st !== 'board' || p.bt < 0.55);
    punks.sort((a, b) => a.x - b.x);
  }
  // the road, the figures and the Defender, into one view (text in screen pixels)
  function drawWorld(v, { labels = true, night = false }) {
    const { g, W, Y, L, park } = v, sx = (wx) => park + wx * L;
    const bounce = Math.sin(car.bump * 16) * Math.exp(-car.bump * 6) * L * 0.025;
    const leaving = car.mode === 'leaving' ? Math.min(1, car.t / 3.4) : 0;
    let lastLabel = -1e9;
    for (const p of punks) {
      const px = sx(p.x), h = p.h * L;
      if (p.st === 'board') { const q = p.bt / 0.55; punk(g, px - q * L * 0.1, Y - q * h * 0.25, h * (1 - 0.4 * q), p.ph, p.s, false, 1 - q); continue; }
      if (px < -h || px > W + h) continue;
      punk(g, px, Y, h, p.ph, p.s, p.st === 'walk');
      if (labels && px - lastLabel > 80) {   // one label per figure, unless they bunch up
        lastLabel = px;
        g.font = `10px ${MONO}`; g.textAlign = 'center'; g.textBaseline = 'bottom';
        g.fillStyle = p.s.gold ? '#e2b84a' : night ? '#a8a8a8' : '#8f8f8f'; g.fillText(p.tag + (p.more ? ` +${p.more}` : ''), px, Y - h - 6);
        const amount = fmtAmt(p.sats); if (amount) { g.fillStyle = '#b3b3b3'; g.fillText(amount, px, Y - h - 18); }
      }
    }
    defender(g, sx(car.x), Y + bounce, L, { fill: car.fill, label: car.label, wheel: -car.dist / 0.12, alpha: 1 - 0.9 * Math.pow(leaving, 2.5), scale: 1 - 0.2 * leaving, lights: night });
  }
  // ---- the band ----
  function drawBand(still) {
    const v = bandLayout(), { g, W, H, Y, L, tab, ticker, phone } = v;
    g.fillStyle = '#171717'; g.fillRect(0, 0, W, H); g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, W, 1);   // an opaque band; the page scrolls above it
    const d = streetData, mined = car.mode === 'leaving' && car.label, fx = (sats) => { const f = fiatShort(sats); return f ? ' ≈ ' + f : ''; };
    if (ticker || phone) {   // the one-line form (a phone's open scene sits under its line)
      g.font = `10.5px ${MONO}`; g.textBaseline = 'middle'; g.textAlign = 'left';
      let a, b;
      if (streetErr) { a = tr('the street'); b = tr('waiting for the node…'); } else if (!d) { a = tr('the street'); b = tr('loading…'); }
      else if (mined) { a = tr('block {n} mined', { n: fmtN(car.label.height) }); b = `${fmtN(car.label.txs)} tx · ${fmtBtc(car.label.sats)} ₿${fx(car.label.sats)}`; }
      else { a = `#${fmtN(d.tip.height + 1)}`; b = `${fmtN(d.next.txs)} tx · ${fmtBtc(d.next.sats)} ₿${fx(d.next.sats)} · ` + tr('{n} waiting', { n: fmtN(d.mempool.txs) }); if (g.measureText(a + '  ' + b).width > W - 64) b = `${fmtN(d.next.txs)} tx · ${fmtBtc(d.next.sats)} ₿ · ` + tr('{n} waiting', { n: fmtN(d.mempool.txs) }); }
      const yy = ticker ? (H - tab) / 2 : 15;
      g.fillStyle = '#ff8a33'; g.fillText(a, 14, yy); g.fillStyle = '#b3b3b3'; g.fillText(b, 14 + g.measureText(a).width + 9, yy);
      g.fillStyle = '#6f6f6f'; g.textAlign = 'right'; g.font = `12px ${SANS}`; g.fillText('×', W - 12, yy); g.fillText(ticker ? '▴' : '▾', W - 32, yy);
      if (ticker) return;
    } else {   // the controls of the full band: collapse, hide
      g.fillStyle = '#6f6f6f'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.font = `12px ${SANS}`; g.fillText('×', W - 12, 15); g.fillText('▾', W - 32, 15);
    }
    g.fillStyle = ROAD; g.fillRect(0, Y - L * 0.06, W, L * 0.06 + 8);                                   // the road
    g.strokeStyle = '#2e2e2e'; g.lineWidth = 1; g.setLineDash([L * 0.12, L * 0.1]); g.beginPath(); g.moveTo(0, Y - L * 0.03); g.lineTo(W, Y - L * 0.03); g.stroke(); g.setLineDash([]);
    drawWorld(v, { labels: true });
    if (phone) return;
    // the panel on the left: block, transactions, value, the queue
    g.textAlign = 'left'; g.textBaseline = 'top';
    const line = (str, yy, font, color) => { g.font = font; g.fillStyle = color; g.fillText(str, 18, yy); return g.measureText(str).width; };
    if (streetErr) { line(tr('THE STREET'), 16, `600 11px ${MONO}`, '#ff8a33'); line(tr('waiting for the Olesia node…'), 34, `13px ${SANS}`, '#8f8f8f'); }
    else if (!d) { line(tr('THE STREET'), 16, `600 11px ${MONO}`, '#ff8a33'); line(tr('loading…'), 34, `13px ${SANS}`, '#8f8f8f'); }
    else {
      const L1 = mined ? car.label : { height: d.tip.height + 1, txs: d.next.txs, sats: d.next.sats };
      line(mined ? tr('BLOCK {n} · MINED', { n: fmtN(L1.height) }) : tr('BLOCK {n} · LOADING', { n: fmtN(L1.height) }), 16, `600 11px ${MONO}`, '#ff8a33');
      line(tr('{n} transactions', { n: fmtN(L1.txs) }), 34, `600 20px ${SANS}`, '#f4f4f4');
      const w1 = line(`${fmtBtc(L1.sats)} BTC`, 60, `600 20px ${SANS}`, '#f4f4f4');
      const f = fiatShort(L1.sats); if (f) { g.font = `500 14px ${MONO}`; g.fillStyle = '#8f8f8f'; g.fillText(`≈ ${f}`, 18 + w1 + 10, 65); }
      line(mined ? tr('block {n} loading next', { n: fmtN(d.tip.height + 1) }) : tr('{n} waiting in the mempool', { n: fmtN(d.mempool.txs) }) + (d.next.valued < d.next.txs ? ' · ' + tr('value so far') : ''), 92, `11px ${MONO}`, '#8f8f8f');
      if (H - tab >= 200) {   // the legend, wrapped into as many lines as the room left of the vehicle needs
        g.font = `10px ${MONO}`; const maxW = Math.max(160, v.park - 34), lines = [];
        for (const seg of (tr('hoodie bc1q · coat 1… · suit 3… · visor bc1p · gold P2PK / Satoshi era') + ' · ' + tr('click a figure or the Defender to open it on mempool.space') + ' · ' + tr('the Street tab has the whole scene')).split(' · ')) {
          const cand = lines.length ? lines[lines.length - 1] + ' · ' + seg : seg;
          if (lines.length && g.measureText(cand).width <= maxW) lines[lines.length - 1] = cand; else lines.push(seg);
        }
        lines.forEach((l, i) => line(l, Y - L * 0.06 - 22 - (lines.length - 1 - i) * 13, `10px ${MONO}`, '#5f5f5f'));
      }
    }
  }
  // ---- the Street page: sky, skyline, lamps, the last blocks driving away, and the world ----
  const skyline = [];   // buildings, made once: [x (world units from 0 at the left), w, h, windows seed]
  (function makeSkyline() { let seed = 7; const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; let x = -1; while (x < 30) { const w = 0.3 + r() * 0.6; skyline.push([x, w, 0.4 + r() * r() * 1.6, Math.floor(r() * 1e6)]); x += w + 0.04 + r() * 0.2; } })();
  const clouds = [[0.1, 0.18, 0.9], [0.45, 0.1, 1.2], [0.75, 0.22, 0.8], [1.1, 0.14, 1.0]];   // x (of W), y (of H), size
  let cloudT = 0;
  function dayPhase() {   // 0 = night, 1 = day, between = dawn/dusk, from the local clock
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    if (h < 5 || h >= 21) return 0;
    if (h < 7) return (h - 5) / 2;
    if (h < 19) return 1;
    return 1 - (h - 19) / 2;
  }
  const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  function drawPage(now, still) {
    const v = pageLayout(), { g, W, H, Y, L, park } = v, d = streetData, dp = dayPhase(), night = dp < 0.5;
    // sky: night → dawn → day, with an orange band at dusk
    const topC = mix(mix([8, 12, 24], [255, 140, 60], Math.min(1, dp * 2) * (dp < 1 ? 0.6 : 0)), [86, 142, 214], Math.max(0, dp * 2 - 1));
    const botC = mix(mix([18, 22, 36], [255, 190, 90], Math.min(1, dp * 2) * (dp < 1 ? 0.8 : 0)), [190, 214, 236], Math.max(0, dp * 2 - 1));
    const sky = g.createLinearGradient(0, 0, 0, Y); sky.addColorStop(0, rgb(topC)); sky.addColorStop(1, rgb(botC)); g.fillStyle = sky; g.fillRect(0, 0, W, H);
    if (night) { g.fillStyle = `rgba(255,255,255,${0.7 * (1 - dp * 2)})`; let seed = 3; const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; for (let i = 0; i < 70; i++) { const x = r() * W, y = r() * Y * 0.6, tw = 0.5 + 0.5 * Math.sin(now / 700 + i); g.fillRect(x, y, 1.5 * tw, 1.5 * tw); } }
    else { const sun = dp < 1 ? [W * 0.85, Y - L * 0.6] : [W * 0.8, L * 0.5]; const sg = g.createRadialGradient(sun[0], sun[1], 0, sun[0], sun[1], L * 0.9); sg.addColorStop(0, 'rgba(255,240,200,.95)'); sg.addColorStop(0.25, 'rgba(255,220,150,.5)'); sg.addColorStop(1, 'rgba(255,220,150,0)'); g.fillStyle = sg; g.fillRect(0, 0, W, Y); }
    if (!still) cloudT += (now - streetLast) / 1000;
    g.fillStyle = night ? 'rgba(40,46,66,.8)' : 'rgba(255,255,255,.75)';
    for (const [cx, cy, cs] of clouds) { const x = ((cx * W + cloudT * 6) % (W + L * 2)) - L, y = cy * Y, s = cs * L * 0.22; g.beginPath(); g.ellipse(x, y, s * 1.6, s * 0.55, 0, 0, Math.PI * 2); g.ellipse(x - s * 0.8, y + s * 0.15, s, s * 0.45, 0, 0, Math.PI * 2); g.ellipse(x + s * 0.9, y + s * 0.1, s * 1.1, s * 0.5, 0, 0, Math.PI * 2); g.fill(); }
    // the skyline, far behind the road
    const base = Y - L * 1.0, bs = L * 0.62;
    for (const [bx, bw, bh, ws] of skyline) {
      const x = bx * bs, w = bw * bs, h = bh * bs; if (x > W) break;
      g.fillStyle = night ? '#10141d' : '#6a7891'; g.fillRect(x, base - h, w, h + 2);
      let seed = ws; const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      const cols = Math.max(1, Math.floor(w / (bs * 0.1))), rows = Math.max(1, Math.floor(h / (bs * 0.12)));
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) { const on = r() < (night ? 0.22 : 0.18); if (!on) continue; g.fillStyle = night ? (r() < 0.12 ? 'rgba(255,138,51,.8)' : r() < 0.25 ? 'rgba(159,216,255,.7)' : 'rgba(255,233,168,.75)') : 'rgba(255,255,255,.45)'; g.fillRect(x + bs * 0.03 + i * bs * 0.1, base - h + bs * 0.04 + j * bs * 0.12, bs * 0.035, bs * 0.05); }
    }
    // the far lane: the last blocks, driving away (newest nearest the right), each with its number
    const blocks = d ? d.blocks || [] : [];
    const farY = Y - L * 1.05;
    g.fillStyle = night ? '#171c24' : '#3c4452'; g.fillRect(0, farY - L * 0.02, W, L * 0.05);
    blocks.slice(0, 6).forEach((b, i) => {
      const age = Math.max(0, (Date.now() - b.seen) / 1000), x = W * 0.92 - L * (1.25 * i) - Math.min(L * 0.6, age / 600 * L * 0.6), sc = 0.36;
      if (x < -L) return;
      defender(g, x, farY, L, { fill: 1, label: { height: b.height, mined: true }, wheel: -age / 0.12, alpha: Math.max(0.35, 1 - i * 0.12), scale: sc, lights: night });
      if (L < 130) return;   // a phone: the small vehicles alone, no room for labels
      g.font = `9.5px ${MONO}`; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillStyle = night ? '#9a9a9a' : '#2b2518';
      g.fillText(`${fmtN(b.txs)} tx · ${fmtBtc(b.sats)} ₿`, x + L * sc * 0.5, farY - L * sc * 0.98);
    });
    // the ground, the kerb, the road, the lamp posts
    g.fillStyle = night ? '#1d2129' : '#5e6b5a'; g.fillRect(0, Y - L * 0.26, W, L * 0.2);
    g.fillStyle = night ? '#2a2f38' : '#9aa0a8'; g.fillRect(0, Y - L * 0.08, W, L * 0.03);
    g.fillStyle = ROAD; g.fillRect(0, Y - L * 0.06, W, H - Y + L * 0.06);
    g.strokeStyle = '#3a3a3a'; g.lineWidth = Math.max(1, L * 0.012); g.setLineDash([L * 0.12, L * 0.1]); g.beginPath(); g.moveTo(0, Y + (H - Y) * 0.5); g.lineTo(W, Y + (H - Y) * 0.5); g.stroke(); g.setLineDash([]);
    for (let x = park - L * 1.6; x < W + L; x += L * 2.3) {
      g.fillStyle = '#2b2b2b'; g.fillRect(x - L * 0.012, Y - L * 1.15, L * 0.024, L * 1.1); g.fillRect(x - L * 0.012, Y - L * 1.15, L * 0.14, L * 0.02);
      g.fillStyle = night ? '#ffe9a8' : '#555'; g.fillRect(x + L * 0.09, Y - L * 1.15, L * 0.06, L * 0.03);
      if (night) { const lg = g.createRadialGradient(x + L * 0.12, Y - L * 1.13, 0, x + L * 0.12, Y - L * 1.13, L * 0.7); lg.addColorStop(0, 'rgba(255,233,168,.28)'); lg.addColorStop(1, 'rgba(255,233,168,0)'); g.fillStyle = lg; g.fillRect(x - L * 0.6, Y - L * 1.2, L * 1.4, L * 1.2); }
    }
    // the sign by the bay: BLOCK n · LOADING, the count, the value; and the queue sign on the right
    const mined = car.mode === 'leaving' && car.label, bw = Math.max(L * 1.3, 190), sx = Math.max(bw / 2 + 6, park - L * 0.62);   // the sign by the bay, left of the Defender's bonnet
    const fs = (k, min) => `${Math.max(min, Math.round(L * k))}px`;
    g.fillStyle = '#2b2b2b'; g.fillRect(sx - L * 0.01, Y - L * 0.64, L * 0.02, L * 0.58);
    g.fillStyle = night ? '#1b1b1b' : '#f4f4f4'; g.strokeStyle = '#ff6a00'; g.lineWidth = 2; g.beginPath(); g.roundRect(sx - bw / 2, Y - L * 0.96, bw, L * 0.34, 4); g.fill(); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const ink = night ? '#f4f4f4' : '#171717', sub = night ? '#b3b3b3' : '#444';
    const fit = (str, maxW) => { while (g.measureText(str).width > maxW && str.length > 4) str = str.slice(0, -2) + '…'; return str; };
    if (!d) { g.fillStyle = '#ff8a33'; g.font = `600 ${fs(0.07, 11)} ${MONO}`; g.fillText(fit(streetErr ? tr('waiting for the Olesia node…') : tr('loading…'), bw - 12), sx, Y - L * 0.79); }
    else {
      const L1 = mined ? car.label : { height: d.tip.height + 1, txs: d.next.txs, sats: d.next.sats };
      g.fillStyle = '#ff8a33'; g.font = `600 ${fs(0.065, 10)} ${MONO}`; g.fillText(fit(mined ? tr('BLOCK {n} · MINED', { n: fmtN(L1.height) }) : tr('BLOCK {n} · LOADING', { n: fmtN(L1.height) }), bw - 12), sx, Y - L * 0.885);
      g.fillStyle = ink; g.font = `600 ${fs(0.085, 14)} ${SANS}`; g.fillText(fit(`${fmtN(L1.txs)} tx · ${fmtBtc(L1.sats)} ₿`, bw - 12), sx, Y - L * 0.79);
      const f = fiatShort(L1.sats); g.fillStyle = sub; g.font = `${fs(0.058, 9)} ${MONO}`; g.fillText(fit((f ? `≈ ${f} · ` : '') + tr('fee floor {n} sat/vB', { n: (d.next.minRate || 0).toFixed(1) }), bw - 12), sx, Y - L * 0.7);
      // the queue: who is waiting beyond the right edge (top right, in the sky)
      g.textAlign = 'right'; g.fillStyle = night ? '#f4f4f4' : '#171717'; g.font = `600 ${fs(0.075, 12)} ${MONO}`; g.fillText('→ ' + tr('{n} waiting', { n: fmtN(d.mempool.txs) }), W - 14, Math.max(16, L * 0.16));
      g.fillStyle = night ? '#b3b3b3' : '#333'; g.font = `${fs(0.058, 9)} ${MONO}`; g.fillText(fit(tr('≈ {n} blocks of transactions in the mempool', { n: (d.mempool.vbytes / 1e6).toFixed(1) }), W * 0.6), W - 14, Math.max(32, L * 0.27));
    }
    drawWorld(v, { labels: true, night });
    // a hint along the bottom
    if (W >= 560) { g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillStyle = '#6f6f6f'; g.font = `10px ${MONO}`; g.fillText(tr('click a figure or the Defender to open it on mempool.space'), 12, H - 6); }
  }
  function streetFrame(now) {
    if (!active()) return;
    streetRaf = requestAnimationFrame(streetFrame);
    const still = reducedMotion();                                                  // reduced motion: still pictures, redrawn once a second as the data changes
    if (now - streetLast < (still ? 1000 : 31)) return;                             // ~30 frames a second is plenty
    const dt = still ? 0 : Math.min(0.1, (now - streetLast) / 1000 || 0);
    if (document.hidden || introOn) { streetLast = now; return; }
    streetStep(dt, still);
    if (streetOn && !pageOn) drawBand(still);   // the band is hidden under the Street page (the scene is right there)
    if (pageOn) drawPage(now, still);
    streetLast = now;
  }
  function streetTick() { cancelAnimationFrame(streetRaf); if (active()) streetRaf = requestAnimationFrame(streetFrame); }
  // ---- the Street page's words: live numbers, the last blocks, the legend ----
  function streetStats() {
    const d = streetData, box = $('#st_stats'), bl = $('#st_blocks'); box.textContent = ''; bl.textContent = '';
    const card = (k, v, s, parent = box) => { const c = el('div', 'st'); c.append(el('div', 'k', k), el('div', 'v', v), el('div', 's', s || '')); parent.appendChild(c); return c; };
    if (!d) { card(tr('The street'), '—', streetErr ? tr('waiting for the Olesia node…') : tr('loading…')); return; }
    const now = Date.now() / 1000, since = Math.max(0, now - d.tip.time);
    card(tr('Last block'), fmtN(d.tip.height), tr('mined {ago} · {n} tx', { ago: ago(since), n: fmtN(d.tip.txs) }));
    card(tr('Loading now'), tr('{n} tx', { n: fmtN(d.next.txs) }), `${fmtBtc(d.next.sats)} ₿` + (fiatShort(d.next.sats) ? ` ≈ ${fiatShort(d.next.sats)}` : '') + ' · ' + tr('fee floor {n} sat/vB', { n: (d.next.minRate || 0).toFixed(1) }));
    card(tr('Waiting'), fmtN(d.mempool.txs), tr('≈ {n} blocks of transactions in the mempool', { n: (d.mempool.vbytes / 1e6).toFixed(1) }));
    card(tr('Last reward'), `${fmtBtc((d.tip.subsidy || 0) + (d.tip.fees || 0))} ₿`, tr('{subsidy} ₿ new coins + {fees} ₿ in fees', { subsidy: fmtBtc(d.tip.subsidy || 0), fees: fmtBtc(d.tip.fees || 0) }));
    (d.blocks || []).slice(0, 6).forEach((b, i, arr) => {
      const prev = arr[i + 1], took = prev ? b.time - prev.time : null;
      const c = card(tr('Block {n}', { n: fmtN(b.height) }), `${fmtN(b.txs)} tx`, `${fmtBtc(b.sats)} ₿ · ` + (took != null ? tr('took {t}', { t: dur(took) }) : ago(Math.max(0, now - b.time))), bl);
      c.classList.add('blk'); const cv = el('canvas'); cv.width = 300; cv.height = 92; c.prepend(cv);
      const g = cv.getContext('2d'); defender(g, 100, 88, 100, { fill: 1, label: { height: b.height, mined: true }, wheel: i });
      c.title = tr('Open block {n} on mempool.space', { n: fmtN(b.height) });
      c.addEventListener('click', () => { if (/^[0-9a-f]{64}$/.test(b.hash || '')) window.open('https://mempool.space/block/' + b.hash, '_blank', 'noopener,noreferrer'); });
    });
  }
  function legendRender() {
    const box = $('#st_legend'); box.textContent = '';
    LEGEND.forEach((fam, i) => {
      const f = FAMILIES[fam], c = el('div', 'fam'), cv = el('canvas'); cv.width = 168; cv.height = 192; c.appendChild(cv);
      const g = cv.getContext('2d');
      [0.5, 1.2].forEach((ox, k) => punk(g, 44 + k * 78, 180, 150, 0, wardrobe(fam, 1000 + i * 17 + k * 101), false));   // two of each, so the variety shows
      const m = el('div'); m.append(el('b', null, tr(f.name)), el('span', 'tg', tr(f.tag)), el('p', null, tr(f.about))); c.appendChild(m);
      box.appendChild(c);
    });
  }
  function streetReword() { $('#w_street').textContent = streetOn ? tr('Hide the street') : tr('Show the street'); if (pageOn) { legendRender(); streetStats(); } }
  // ---- pointer: a figure (its transaction) or the Defender (its block) — both open on mempool.space ----
  function hitIn(v, x, y) {
    const { Y, L, park } = v, sx = (wx) => park + wx * L;
    for (const p of punks) { const px = sx(p.x), h = p.h * L; if (p.st !== 'board' && Math.abs(x - px) < h * 0.22 && y > Y - h * 1.1 && y < Y) return { p, url: /^[0-9a-f]{64}$/.test(p.txid || '') ? 'https://mempool.space/tx/' + p.txid : null, what: 'tx' }; }
    const cx = sx(car.x);
    if (x > cx && x < cx + L && y > Y - L && y < Y && car.label) return { url: car.label.mined && streetData && /^[0-9a-f]{64}$/.test(streetData.tip.hash || '') ? 'https://mempool.space/block/' + streetData.tip.hash : 'https://mempool.space/mempool-block/0', what: 'block' };
    return null;
  }
  function bandHit(ev) {
    const r = street.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, v = bandLayout();
    if (y < 30 && x > v.W - 24) return { what: 'hide' };
    if (y < 30 && x > v.W - 44) return { what: 'mode' };
    if (v.ticker) return null;
    return hitIn(v, x, y);
  }
  street.addEventListener('click', (ev) => {
    const hit = bandHit(ev);
    if (!hit) { if (isPhone()) bandMode(!bandIsFull()); return; }   // a phone: tapping the line opens the scene and back
    if (hit.what === 'hide') return streetSet(false);
    if (hit.what === 'mode') return bandMode(!bandIsFull());
    if (hit.url) window.open(hit.url, '_blank', 'noopener,noreferrer');
  });
  street.addEventListener('mousemove', (ev) => { const h = bandHit(ev); street.style.cursor = h && (h.url || h.what === 'hide' || h.what === 'mode') ? 'pointer' : isPhone() ? 'pointer' : 'default'; });
  const tip = $('#st_tip');
  stCanvas.addEventListener('mousemove', (ev) => {
    const r = stCanvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, h = hitIn(pageLayout(), x, y);
    stCanvas.style.cursor = h && h.url ? 'pointer' : 'default';
    if (!h || !h.p) { tip.classList.add('hide'); return; }
    const p = h.p, a = p.a || {}; tip.textContent = '';
    tip.append(el('b', null, (p.s.fam === 'satoshi' ? tr('Satoshi-era coin') : tr(FAMILIES[p.s.fam].name)) + ' · ' + p.tag));
    const rows = [];
    if (p.sats !== null && p.sats !== undefined) rows.push(tr('{amount} moving', { amount: fmtAmt(p.sats) }) + (fiatShort(p.sats) ? ` ≈ ${fiatShort(p.sats)}` : ''));
    if (a.rate) rows.push(tr('{n} sat/vB · {v} vB', { n: Number(a.rate).toFixed(1), v: fmtN(a.vsize) }));
    if (a.era !== null && a.era !== undefined) rows.push(tr('spends a coin from block {n}', { n: fmtN(a.era) }));
    if (p.more) rows.push(tr('+{n} more arrived with it', { n: p.more }));
    rows.forEach((t) => tip.appendChild(el('div', null, t)));
    if (p.txid) tip.appendChild(el('div', 'mono', p.txid.slice(0, 16) + '… · ' + tr('click to open')));
    tip.classList.remove('hide');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(4, Math.min(r.width - tw - 4, x + 14)) + 'px'; tip.style.top = Math.max(4, y - th - 12) + 'px';
  });
  stCanvas.addEventListener('mouseleave', () => tip.classList.add('hide'));
  stCanvas.addEventListener('click', (ev) => { const r = stCanvas.getBoundingClientRect(), h = hitIn(pageLayout(), ev.clientX - r.left, ev.clientY - r.top); if (h && h.url) window.open(h.url, '_blank', 'noopener,noreferrer'); });
  $('#set_street').addEventListener('change', (e) => streetSet(e.target.checked));
  $('#st_band').addEventListener('change', (e) => streetSet(e.target.checked));
  $('#w_street').addEventListener('click', () => streetSet(!streetOn));
  window.addEventListener('resize', () => { streetLast = 0; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) { streetLast = performance.now(); streetPoll(); } });
  { const m = bandSaved(); if (m === 'full' || m === 'ticker') bandFull = m === 'full'; }
  show(street, streetOn); document.body.classList.toggle('street', streetOn); $('#set_street').checked = streetOn; $('#st_band').checked = streetOn; $('#w_street').textContent = streetOn ? tr('Hide the street') : tr('Show the street');
  if (streetOn) { streetPoll(); streetTick(); }
})();
