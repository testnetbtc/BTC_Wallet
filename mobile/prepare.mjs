// Build the web wallet and copy it into www/ so Capacitor bundles it locally.
// If the wallet's build deps aren't installed (e.g. a clean CI checkout), fall
// back to the pre-built index.html that is committed in www/ — the app still
// builds, it just uses the last committed bundle.
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'packages', 'bitcoin', 'web');
const WWW = join(HERE, 'www');
mkdirSync(WWW, { recursive: true });
let fresh = false;
try {
  console.log('building wallet…');
  execSync('node web/build.mjs', { cwd: join(HERE, '..', 'packages', 'bitcoin'), stdio: 'inherit' });
  fresh = true;
} catch (e) {
  // M6 — a RELEASE build must never ship a stale fallback bundle: fail closed. Only a dev
  // build may fall back to the committed www/index.html, and even then only if it is hardened
  // (checked below). A Capacitor WebView has NO HTTP headers, so the in-page CSP is the ONLY
  // enforcement — an unsafe-inline fallback would silently defeat the whole defense-in-depth.
  if (process.env.RELEASE) throw new Error('RELEASE build: wallet build failed and a fallback bundle must NOT be shipped — fix the build: ' + e.message);
  if (!existsSync(join(WWW, 'index.html'))) throw new Error('wallet build failed and no pre-built www/index.html to fall back on: ' + e.message);
  console.log('! wallet build unavailable here — using the committed www/index.html (dev only)');
}
if (fresh) copyFileSync(join(WEB, 'index.html'), join(WWW, 'index.html'));

// M6 — whatever we are about to bundle (fresh OR fallback) MUST be hardened. Refuse to ship a
// mobile www whose CSP permits inline/eval script, or that has no CSP at all.
const bundled = readFileSync(join(WWW, 'index.html'), 'utf8');
if (!/http-equiv=["']?content-security-policy/i.test(bundled))
  throw new Error('refusing to bundle mobile www: no Content-Security-Policy meta present');
if (/script-src[^;]*'unsafe-inline'/i.test(bundled) || /script-src[^;]*'unsafe-eval'/i.test(bundled))
  throw new Error('refusing to bundle mobile www: script-src permits unsafe-inline/eval — rebuild the hardened wallet');
for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'])
  copyFileSync(join(WEB, 'pwa', f), join(WWW, f));
console.log('www/ ready — run `npx cap sync ios` on the Mac');
