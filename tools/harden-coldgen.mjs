// Cold-generator hardening — part of its reproducible build. Runs AFTER
// build.mjs + assemble.mjs have produced index.html. The generator is fully
// OFFLINE, so connect-src is 'none' and the strict CSP matters most in the <meta>
// (the only policy that applies when the file is opened from disk, file://).
import { copyFileSync, mkdirSync } from 'node:fs';
import { hardenHtml } from './csp.mjs';

mkdirSync('public', { recursive: true });
// harden the canonical artifact in place (this is the file whose SHA-256 is pinned)
const { csp, scriptHashes } = hardenHtml({
  htmlPath: 'index.html', headersPath: 'public/_headers',
  connect: "'none'", img: 'data:', manifest: false,
});
copyFileSync('index.html', 'public/index.html');
console.log('cold-gen hardened:', scriptHashes, 'script hash(es) · connect-src none · public/{index.html,_headers}');
console.log('CSP:', csp);
