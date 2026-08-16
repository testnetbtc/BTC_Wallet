// M6 / L13 — the COMMITTED mobile Capacitor bundle must be hardened. A WebView has no HTTP
// response headers, so the in-page CSP is the ONLY enforcement; an unsafe-inline script-src
// (the old stale artifact) would silently defeat the whole defense-in-depth exactly where the
// keys live. This guards the committed www/index.html and the App-Bound Domains flag.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(66), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

const www = readFileSync(join(ROOT, 'mobile', 'www', 'index.html'), 'utf8');
ok('M6: committed mobile www has a Content-Security-Policy meta', /http-equiv=["']?content-security-policy/i.test(www));
ok('M6: mobile www script-src is hash-based (no unsafe-inline)', /script-src[^;]*'sha256-/.test(www) && !/script-src[^;]*'unsafe-inline'/.test(www));
ok('M6: mobile www script-src has no unsafe-eval', !/script-src[^;]*'unsafe-eval'/.test(www));

const cap = JSON.parse(readFileSync(join(ROOT, 'mobile', 'capacitor.config.json'), 'utf8'));
ok('L13: iOS App-Bound Domains enabled', !!cap.ios && cap.ios.limitsNavigationsToAppBoundDomains === true);

console.log(bad ? '\nMOBILE-HARDEN TEST FAILED' : '\nMOBILE-HARDEN TEST PASS — committed WebView bundle hardened, App-Bound Domains on');
process.exit(bad ? 1 : 0);
