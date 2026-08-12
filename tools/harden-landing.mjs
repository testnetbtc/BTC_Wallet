// Harden the landing site (olesia.io). Static pages get a strict no-script CSP;
// the faucet and P2PK pages get their inline-script hashes plus exactly the hosts
// they legitimately need. The faucet uses Cloudflare Turnstile (external anti-bot
// widget: a script from challenges.cloudflare.com in an iframe) — an explicit,
// justified host allowance, NOT a script 'unsafe-inline' escape hatch.
//
// IMPORTANT: `_headers` puts the SECURITY headers on `/*` but the CSP ONLY on
// per-page rules. Two overlapping CSPs (e.g. `/*` + `/faucet/*`) are enforced as
// their INTERSECTION, so a broad `script-src 'none'` on `/*` would block a page's
// own scripts. Keeping CSP per-page avoids that; every page is enumerated.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inlineScriptHashes, buildCSP, securityHeaders, injectMetaCSP } from './csp.mjs';

const ROOT = 'landing';
const TURNSTILE = 'https://challenges.cloudflare.com';

// per-page CSP config. `paths` are the header globs that map to `file`.
const PAGES = [
  { file: 'index.html', paths: ['/', '/index.html'], connect: "'none'" },
  { file: 'learn/index.html', paths: ['/learn/*'], connect: "'none'" },
  { file: 'privacy/index.html', paths: ['/privacy/*'], connect: "'none'" },
  { file: 'faucet/index.html', paths: ['/faucet/*'],
    connect: `'self' https://faucet.olesia.io ${TURNSTILE}`,
    scriptHosts: [TURNSTILE], frame: TURNSTILE, formAction: "'self'" },
  { file: 'p2pk/index.html', paths: ['/p2pk/*'],
    connect: "'self' https://mempool.space" },
];

// 1) security headers (no CSP) on everything
let out = '/*\n' + Object.entries(securityHeaders()).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n\n';

// 2) per-page CSP
for (const pg of PAGES) {
  const fp = join(ROOT, pg.file);
  if (!existsSync(fp)) continue;
  const html = readFileSync(fp, 'utf8');
  const csp = buildCSP({
    scriptHashes: inlineScriptHashes(html), scriptHosts: pg.scriptHosts || [],
    connect: pg.connect, img: "'self' data:", frame: pg.frame || "'none'", formAction: pg.formAction || "'none'",
  });
  const updated = injectMetaCSP(html, csp);
  if (updated !== html) writeFileSync(fp, updated);
  for (const path of pg.paths) out += `${path}\n  Content-Security-Policy: ${csp}\n\n`;
}

// 3) preserve the NIP-05 cross-origin rule (Nostr clients fetch it)
out += '/.well-known/nostr.json\n  Access-Control-Allow-Origin: *\n  Content-Type: application/json\n  Cache-Control: no-store, must-revalidate\n';
writeFileSync(join(ROOT, '_headers'), out);
console.log('landing hardened: /* security headers + per-page CSP');
