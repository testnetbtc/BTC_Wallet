// Web Worker for the vanity search. Bundled by build.mjs into a string that entry.js turns into a
// blob: worker. Messages in: {cmd:'bench'} | {cmd:'start', type, text, ignoreCase}. Messages out:
// {rate} | {progress: keysTried} | {found: {wif, address, type}} | {error}.
// The private key exists here only as the result object posted back to the page (same origin,
// in memory). Randomness: crypto.getRandomValues, nothing else.
import { analyzePattern, createSearch, benchmark } from '../src/vanity.js';

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
let running = false;

self.onmessage = (ev) => {
  const m = ev.data || {};
  try {
    if (m.cmd === 'bench') { self.postMessage({ rate: benchmark({ randomBytes, ms: m.ms || 1200 }) }); return; }
    if (m.cmd === 'start') {
      const analysis = analyzePattern({ type: m.type, text: m.text, ignoreCase: !!m.ignoreCase });
      if (!analysis.ok) { self.postMessage({ error: analysis.errors.join('; ') }); return; }
      const search = createSearch({ analysis, randomBytes });
      running = true;
      let lastReport = Date.now(), reported = 0n;
      const loop = () => {
        if (!running) return;
        const r = search.step(4096);
        if (r) { running = false; self.postMessage({ found: { wif: r.found.wif, address: r.found.address, type: r.found.type }, tried: Number(search.tried) }); return; }
        const now = Date.now();
        if (now - lastReport > 250) { self.postMessage({ progress: Number(search.tried - reported) }); reported = search.tried; lastReport = now; }
        setTimeout(loop, 0);   // yield so 'stop' messages are seen
      };
      loop();
      return;
    }
    if (m.cmd === 'stop') { running = false; return; }
  } catch (e) { running = false; self.postMessage({ error: e.message || String(e) }); }
};
