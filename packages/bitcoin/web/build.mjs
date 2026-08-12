import * as esbuild from 'esbuild';
import { mkdirSync } from 'fs';
import { hardenHtml } from '../../../tools/csp.mjs';

mkdirSync('web/dist', { recursive: true });
await esbuild.build({
  entryPoints: ['web/entry.js'], bundle: true, format: 'iife',
  outfile: 'web/dist/online.bundle.js', target: 'es2020', legalComments: 'none',
});
await import('./assemble.mjs');

// CSP hardening: hash the inline scripts (drop script 'unsafe-inline'), write _headers.
// The wallet talks to the two block explorers and its own broadcast API — nothing else.
const { scriptHashes } = hardenHtml({
  htmlPath: 'web/index.html', headersPath: 'web/_headers',
  connect: 'https://mempool.space https://blockstream.info https://api.olesia.io',
  img: "'self' data:", manifest: true,
  extraHeaderBlocks: '/.well-known/assetlinks.json\n  Content-Type: application/json\n  Cache-Control: no-store\n',
});
console.log('CSP:', scriptHashes, 'script hashes · no script unsafe-inline · _headers written');
