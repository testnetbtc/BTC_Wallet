// One split-key vanity job, run as a child process of the node API (spawned under `nice -n 19`
// so wallet lookups and everything else on the machine keep priority). It knows ONLY the client's
// public point: it searches A + k·G and reports the offset k — which cannot be turned into a key
// without the client's secret. Same engine as the page and the offline script.
//
//   stdin : one JSON line {type, text, ignoreCase, pubkey, threads}
//   stdout: JSON lines {tried:n} (progress) … {found:{offset, address}} | {error}
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { analyzePattern, createSearch } from '../../packages/bitcoin/src/vanity.js';
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

if (!isMainThread) {
  const { type, text, ignoreCase, pubkey } = workerData;
  const analysis = analyzePattern({ type, text, ignoreCase });
  const search = createSearch({ analysis, randomBytes, startPoint: pubkey });
  let reported = 0n, last = Date.now();
  for (;;) {
    const r = search.step(8192);
    if (r) { parentPort.postMessage({ found: { offset: bytesToHex(r.found.offset), address: r.found.address }, tried: Number(search.tried - reported) }); break; }
    if (Date.now() - last > 1000) { parentPort.postMessage({ progress: Number(search.tried - reported) }); reported = search.tried; last = Date.now(); }
  }
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    let job;
    try { job = JSON.parse(input); } catch { process.stdout.write(JSON.stringify({ error: 'bad job' }) + '\n'); process.exit(2); }
    const a = analyzePattern({ type: job.type, text: job.text, ignoreCase: !!job.ignoreCase });
    if (!a.ok) { process.stdout.write(JSON.stringify({ error: a.errors.join('; ') }) + '\n'); process.exit(2); }
    const threads = Math.max(1, Math.min(64, Number(job.threads) || 4));
    const workers = []; let done = false;
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
    for (let i = 0; i < threads; i++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { type: a.type, text: a.text, ignoreCase: a.ignoreCase, pubkey: job.pubkey } });
      w.on('message', (m) => {
        if (done) return;
        if (m.progress) out({ tried: m.progress });
        if (m.found) { done = true; out({ tried: m.tried }); out({ found: m.found }); for (const x of workers) x.terminate(); setTimeout(() => process.exit(0), 50); }
      });
      w.on('error', (e) => { if (!done) { done = true; out({ error: e.message }); process.exit(1); } });
      workers.push(w);
    }
  });
}
