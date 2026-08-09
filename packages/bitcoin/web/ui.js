(function () {
  const $ = (s) => document.querySelector(s);
  const show = (el, msg, cls) => { el.textContent = msg; el.className = cls || ''; };
  let mnemonic = '', network = 'testnet4';
  const fmt = (sats) => (sats / 1e8).toFixed(8) + ' tBTC (' + Number(sats).toLocaleString() + ' sat)';

  // network options: testnet only for this hot wallet
  window.OW.networks.filter((n) => n !== 'mainnet').forEach((n) => {
    const o = document.createElement('option'); o.value = n; o.textContent = n; $('#net').appendChild(o);
  });
  $('#net').value = 'testnet4';

  $('#net').addEventListener('change', () => { network = $('#net').value; if (mnemonic) loadWallet(); });

  $('#gen').addEventListener('click', () => {
    $('#mnemonic').value = window.OW.generate();
    show($('#status'), 'New 24-word seed generated. Write it down. Then press "Load wallet".', 'hint');
  });

  $('#load').addEventListener('click', loadWallet);
  async function loadWallet() {
    const m = $('#mnemonic').value.trim();
    if (!window.OW.validate(m)) { show($('#status'), '✗ not a valid BIP-39 mnemonic (check the words).', 'bad'); return; }
    mnemonic = m; network = $('#net').value;
    const addr = window.OW.address(mnemonic, network);
    show($('#addr'), addr, 'mono');
    try { const q = $('#qr'); q.src = await window.OW.qr(addr); q.style.display = 'inline-block'; } catch {}
    $('#label').value = localStorage.getItem('olesia:label:' + addr) || '';
    $('#recv').style.display = 'block';
    show($('#status'), 'Wallet loaded. Fetching…', 'hint');
    await refreshStatus();
    await refreshHistory();
    $('#actions').style.display = 'block';
  }

  // wallet label persists locally (not a secret)
  $('#label').addEventListener('input', () => {
    const addr = $('#addr').textContent;
    if (addr) localStorage.setItem('olesia:label:' + addr, $('#label').value);
  });

  $('#refresh').addEventListener('click', async () => { await refreshStatus(); await refreshHistory(); });
  async function refreshStatus() {
    try {
      const s = await window.OW.status(mnemonic, network);
      show($('#bal'), fmt(s.balance.confirmed) + ' confirmed' + (s.balance.pending ? '  ·  ' + fmt(s.balance.pending) + ' pending' : ''), 'mono');
      $('#utxos').textContent = s.utxos.length
        ? s.utxos.map((u) => `${u.value} sat ${u.confirmed ? '✓' : 'pending'}`).join('   ·   ')
        : '(no UTXOs yet — send testnet coin to the address above)';
      show($('#status'), 'Balance updated.', 'ok');
    } catch (e) { show($('#status'), '✗ ' + e.message, 'bad'); }
  }

  async function refreshHistory() {
    try {
      const txs = await window.OW.history(mnemonic, network);
      const h = $('#history'); h.textContent = '';
      if (!txs.length) { h.textContent = '(no transactions yet)'; return; }
      const base = window.OW.explorer(network);
      for (const t of txs) {
        const row = document.createElement('div');
        row.style.margin = '3px 0';
        row.style.color = t.net >= 0 ? '#7ee2a8' : '#ff9ca0';
        const amt = (t.net >= 0 ? '+' : '−') + Math.abs(t.net).toLocaleString() + ' sat';
        row.appendChild(document.createTextNode(`${t.confirmed ? '✓' : '⧗ pending'}  ${amt}   `));
        const a = document.createElement('a');
        a.href = base + t.txid; a.target = '_blank'; a.rel = 'noopener'; a.textContent = t.txid.slice(0, 12) + '… ↗';
        row.appendChild(a);
        h.appendChild(row);
      }
    } catch (e) { $('#history').textContent = '✗ ' + e.message; }
  }

  async function runSend(broadcast) {
    try {
      show($('#status'), broadcast ? 'Broadcasting…' : 'Building…', 'hint');
      const res = await window.OW.send({
        mnemonic, network, toAddress: $('#to').value, amount: $('#amt').value,
        message: $('#msg').value, feeRate: $('#fee').value, broadcast,
      });
      renderResult(res, broadcast);
    } catch (e) { show($('#status'), '✗ ' + e.message, 'bad'); }
  }
  $('#dryrun').addEventListener('click', () => runSend(false));
  $('#send').addEventListener('click', () => runSend(true));

  async function runSweep(broadcast) {
    try {
      if (!$('#sweepto').value.trim()) { show($('#status'), 'enter a destination address to sweep to', 'bad'); return; }
      show($('#status'), broadcast ? 'Broadcasting sweep…' : 'Building sweep…', 'hint');
      const res = await window.OW.sweep({ mnemonic, network, toAddress: $('#sweepto').value, feeRate: $('#fee').value, broadcast });
      renderResult(res, broadcast);
    } catch (e) { show($('#status'), '✗ ' + e.message, 'bad'); }
  }
  $('#sweepdry').addEventListener('click', () => runSweep(false));
  $('#sweep').addEventListener('click', () => runSweep(true));

  function renderResult(res, broadcast) {
    const r = $('#result'); r.textContent = '';
    const line = (t) => { const d = document.createElement('div'); d.textContent = t; r.appendChild(d); };
    line(broadcast ? '✓ BROADCAST' : '· DRY RUN (nothing sent)');
    line('txid: ' + res.txid);
    line('fee: ' + res.fee + ' sat  ·  vsize: ' + res.vsize + '  ·  ' + res.feeRate + ' sat/vB');
    if (res.swept != null) line('sweeping ' + res.swept + ' sat → ' + res.to);
    if (broadcast && res.explorer) {
      const a = document.createElement('a');
      a.href = res.explorer; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'view on explorer ↗';
      a.style.color = '#7ee2a8'; r.appendChild(a);
    }
    r.style.display = 'block';
    show($('#status'), broadcast ? '✓ sent — see result below' : 'built (dry run) — press Send to broadcast', broadcast ? 'ok' : 'hint');
    if (broadcast) setTimeout(async () => { await refreshStatus(); await refreshHistory(); }, 1500);
  }
})();
