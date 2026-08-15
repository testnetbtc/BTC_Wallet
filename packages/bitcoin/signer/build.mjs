// Build the OFFLINE signer into a single self-contained, network-less page. Same hardening as
// the cold generator: inline the bundle, hash every inline script, and lock the CSP to
// connect-src 'none' so the page physically cannot reach the network. Run from packages/bitcoin.
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { hardenHtml } from '../../../tools/csp.mjs';

mkdirSync('signer/dist', { recursive: true });
const bundle = (await esbuild.build({
  entryPoints: ['signer/entry.js'], bundle: true, format: 'iife', write: false,
  target: 'es2020', legalComments: 'none',
})).outputFiles[0].text;

const html = readFileSync('signer/index.html', 'utf8').replace('/*__SIGNER_BUNDLE__*/', () => bundle);
writeFileSync('signer/dist/index.html', html);

const { csp, scriptHashes } = hardenHtml({
  htmlPath: 'signer/dist/index.html', headersPath: 'signer/dist/_headers',
  connect: "'none'", img: 'data:', manifest: false,
});
console.log('offline signer built:', scriptHashes, 'script hash(es) · connect-src none · signer/dist/{index.html,_headers}');
console.log('bundle bytes:', bundle.length, '· CSP:', csp);
