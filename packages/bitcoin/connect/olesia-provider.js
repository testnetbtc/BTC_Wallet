// window.olesia — the injected provider on the olesia.io/swap origin (Olesia Wallet ↔ swap
// hand-off, docs/OLESIA_WALLET_HANDOFF_CONTRACT.md). It holds NO keys: it relays
// olesia_getAccount / olesia_signPsbt to the wallet's connect bridge on app.olesia.io (a popup,
// where the seed lives) over postMessage with strict origin pinning, and returns the result.
//
// Delivery: served from the wallet origin (app.olesia.io/olesia-provider.js) and injected into
// the swap page at the edge (the swap tree is never modified). Idempotent + safe to load twice.
(function () {
  if (window.olesia && window.olesia.isOlesia) return;
  var WALLET_ORIGIN = 'https://app.olesia.io';
  var CONNECT_URL = WALLET_ORIGIN + '/connect';
  var pending = {}, seq = 0, popup = null, ready = false, queue = [];

  window.addEventListener('message', function (e) {
    if (e.origin !== WALLET_ORIGIN) return;                 // only trust the wallet origin
    var d = e.data || {};
    if (d.__olesia_ready) { ready = true; flush(); return; }
    var res = d.__olesia_res; if (!res) return;
    var p = pending[res.id]; if (!p) return; delete pending[res.id];
    if (res.error) p.reject(Object.assign(new Error(res.error.message || 'request failed'), { code: res.error.code || 4900 }));
    else p.resolve(res.result);
  });

  function openPopup() {
    if (popup && !popup.closed) return popup;
    ready = false;
    var w = 460, h = 700, y = Math.max(0, (screen.height - h) / 2), x = Math.max(0, (screen.width - w) / 2);
    popup = window.open(CONNECT_URL, 'olesia-connect', 'width=' + w + ',height=' + h + ',left=' + x + ',top=' + y);
    return popup;
  }
  function flush() { while (ready && popup && queue.length) popup.postMessage({ __olesia_req: queue.shift() }, WALLET_ORIGIN); }

  window.olesia = {
    isOlesia: true,
    // EIP-1193-shaped. request({ method, params }) -> Promise. Must be called from a user gesture
    // (the swap page's Connect / Sign buttons) so the wallet popup is allowed to open.
    request: function (args) {
      var method = (args || {}).method, params = (args || {}).params;
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        var timer = setInterval(function () {
          if (popup && popup.closed && pending[id]) { clearInterval(timer); delete pending[id]; reject(Object.assign(new Error('the Olesia wallet window was closed'), { code: 4001 })); }
        }, 700);
        pending[id] = { resolve: function (v) { clearInterval(timer); resolve(v); }, reject: function (e) { clearInterval(timer); reject(e); } };
        var w = openPopup();
        if (!w) { clearInterval(timer); delete pending[id]; return reject(Object.assign(new Error('Please allow pop-ups for olesia.io to connect your Olesia wallet.'), { code: 4900 })); }
        queue.push({ id: id, method: method, params: params });
        if (ready) flush();
      });
    },
  };
  try { window.dispatchEvent(new Event('olesia#initialized')); } catch (e) { /* noop */ }
})();
