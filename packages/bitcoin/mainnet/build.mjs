// Build the Olesia MAINNET wallet — the opening page of olesia.io.
//   cd packages/bitcoin && node mainnet/build.mjs
// Output: mainnet/publish/{index.html,_headers}  +  mainnet/BUILD_HASH.txt
// The page is ONE self-contained file. Its inline scripts are pinned by sha256 in the CSP
// (no script 'unsafe-inline'), and fetch() may reach exactly one host: the Olesia node API.
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'fs';
import { createHash } from 'crypto';
import { hardenHtml } from '../../../tools/csp.mjs';

const API = process.env.OLESIA_API_BASE || 'https://api.olesia.io';
mkdirSync('mainnet/dist', { recursive: true });
await esbuild.build({
  entryPoints: ['mainnet/entry.js'], bundle: true, format: 'iife', minify: false,
  outfile: 'mainnet/dist/mainnet.bundle.js', target: 'es2020', legalComments: 'none',
  define: { __OLESIA_API__: JSON.stringify(API), __OLESIA_FAUCET__: JSON.stringify(process.env.OLESIA_FAUCET_URL || 'https://app.olesia.io/faucet/') },
});
await import('./assemble.mjs');

const { scriptHashes, csp } = hardenHtml({ htmlPath: 'mainnet/index.html', headersPath: 'mainnet/_headers', connect: API, img: "'self' data:" });
console.log('CSP:', scriptHashes, 'script hashes · no script unsafe-inline · connect-src', API);
if (/unsafe-inline/.test(csp.split(';').find((d) => d.trim().startsWith('script-src')))) throw new Error('script-src still allows unsafe-inline');

rmSync('mainnet/publish', { recursive: true, force: true });
mkdirSync('mainnet/publish', { recursive: true });
copyFileSync('mainnet/index.html', 'mainnet/publish/index.html');
copyFileSync('mainnet/_headers', 'mainnet/publish/_headers');

const bytes = readFileSync('mainnet/publish/index.html');
const hash = createHash('sha256').update(bytes).digest('hex');
writeFileSync('mainnet/BUILD_HASH.txt', hash + '  mainnet/publish/index.html\n');
console.log('mainnet wallet sha256:', hash, `(${bytes.length} bytes) -> mainnet/BUILD_HASH.txt`);
