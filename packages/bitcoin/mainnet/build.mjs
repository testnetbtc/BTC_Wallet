// Build the Olesia MAINNET wallet — the opening page of olesia.io.
//   cd packages/bitcoin && node mainnet/build.mjs
// Output: mainnet/publish/{index.html,_headers,olesia-vanity.mjs}  +  mainnet/BUILD_HASH.txt
// The page is ONE self-contained file. Its inline scripts are pinned by sha256 in the CSP
// (no script 'unsafe-inline'), and fetch() may reach exactly one host: the Olesia node API.
// The vanity search runs in Web Workers created from code bundled into the page (worker-src blob:).
// olesia-vanity.mjs is the same engine as a stand-alone offline script; its SHA-256 is shown in the page.
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { hardenHtml, headersBlock } from '../../../tools/csp.mjs';

const API = process.env.OLESIA_API_BASE || 'https://api.olesia.io';
const sha = (b) => createHash('sha256').update(b).digest('hex');
mkdirSync('mainnet/dist', { recursive: true });

// 1. the offline script — one file, no imports left, runs with plain Node.js
await esbuild.build({
  entryPoints: ['vanity/cli.mjs'], bundle: true, format: 'esm', platform: 'node', target: 'node18', minify: false,
  outfile: 'mainnet/dist/olesia-vanity.mjs', legalComments: 'inline',   // esbuild keeps the source's #! line
});
const cli = readFileSync('mainnet/dist/olesia-vanity.mjs');
const cliHash = sha(cli);

// 2. the vanity Web Worker — bundled to a string the page turns into a blob: worker
await esbuild.build({
  entryPoints: ['mainnet/vanity_worker.js'], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: false,
  outfile: 'mainnet/dist/vanity_worker.bundle.js', legalComments: 'none',
});
const workerCode = readFileSync('mainnet/dist/vanity_worker.bundle.js', 'utf8');

// 3. the page bundle
await esbuild.build({
  entryPoints: ['mainnet/entry.js'], bundle: true, format: 'iife', minify: false,
  outfile: 'mainnet/dist/mainnet.bundle.js', target: 'es2020', legalComments: 'none',
  define: {
    __OLESIA_API__: JSON.stringify(API),
    __OLESIA_FAUCET__: JSON.stringify(process.env.OLESIA_FAUCET_URL || 'https://app.olesia.io/faucet/'),
    __OLESIA_VANITY_WORKER__: JSON.stringify(workerCode),
    __OLESIA_VANITY_SCRIPT__: JSON.stringify({ file: 'olesia-vanity.mjs', sha256: cliHash, bytes: cli.length }),
  },
});
await import('./assemble.mjs');

// the offline script is served with "download" semantics (never executed by a browser)
const scriptHeaders = headersBlock('/olesia-vanity.mjs', null).replace('\n', '\n  Content-Type: text/javascript; charset=utf-8\n  Content-Disposition: attachment; filename="olesia-vanity.mjs"\n');
const { scriptHashes, csp } = hardenHtml({ htmlPath: 'mainnet/index.html', headersPath: 'mainnet/_headers', connect: API, img: "'self' data:", worker: 'blob:', extraHeaderBlocks: scriptHeaders });
console.log('CSP:', scriptHashes, 'script hashes · no script unsafe-inline · connect-src', API, '· worker-src blob:');
if (/unsafe-inline/.test(csp.split(';').find((d) => d.trim().startsWith('script-src')))) throw new Error('script-src still allows unsafe-inline');

rmSync('mainnet/publish', { recursive: true, force: true });
mkdirSync('mainnet/publish', { recursive: true });
copyFileSync('mainnet/index.html', 'mainnet/publish/index.html');
copyFileSync('mainnet/_headers', 'mainnet/publish/_headers');
writeFileSync('mainnet/publish/olesia-vanity.mjs', cli);

const bytes = readFileSync('mainnet/publish/index.html');
const hash = sha(bytes);
writeFileSync('mainnet/BUILD_HASH.txt', `${hash}  mainnet/publish/index.html\n${cliHash}  mainnet/publish/olesia-vanity.mjs\n`);
console.log('mainnet wallet sha256:', hash, `(${bytes.length} bytes)`);
console.log('offline script sha256:', cliHash, `(${cli.length} bytes) -> mainnet/BUILD_HASH.txt`);
