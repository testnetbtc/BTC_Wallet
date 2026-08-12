// External security-header verifier. Fetches each Olesia property over the real
// network and asserts the deployment-boundary controls are actually present in the
// HTTP response — configuration in the repo is NOT accepted as proof. Run:
//   node tools/verify-headers.mjs                 # preview URLs (default)
//   node tools/verify-headers.mjs production      # live domains
// NOTE: Cloudflare Pages applies `_headers` to GET, not HEAD — this uses GET.
const TARGETS = {
  preview: {
    wallet: 'https://preview.olesia-wallet.pages.dev/',
    coldgen: 'https://preview.alea-wallet.pages.dev/',
    landing: 'https://preview.olesia-landing.pages.dev/',
    faucet: 'https://preview.olesia-landing.pages.dev/faucet/',
    p2pk: 'https://preview.olesia-landing.pages.dev/p2pk/',
  },
  production: {
    wallet: 'https://app.olesia.io/',
    coldgen: 'https://offline.olesia.io/',
    landing: 'https://olesia.io/',
    faucet: 'https://olesia.io/faucet/',
    p2pk: 'https://olesia.io/p2pk/',
  },
};
const REQUIRED = ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'strict-transport-security', 'permissions-policy'];

const env = process.argv[2] === 'production' ? 'production' : 'preview';
let bad = false;
for (const [name, url] of Object.entries(TARGETS[env])) {
  const res = await fetch(url + '?cb=' + Date.now(), { cache: 'no-store' });
  const h = res.headers;
  const missing = REQUIRED.filter((k) => !h.get(k));
  const csp = h.get('content-security-policy') || '';
  const scriptUnsafe = /script-src[^;]*'unsafe-inline'/.test(csp) || /script-src[^;]*'unsafe-eval'/.test(csp);
  const framed = h.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(csp);
  const okName = missing.length === 0 && !scriptUnsafe && framed;
  if (!okName) bad = true;
  console.log(`${okName ? '✓' : '✗'} ${name.padEnd(8)} ${url}`);
  if (missing.length) console.log('    missing headers:', missing.join(', '));
  if (scriptUnsafe) console.log('    ✗ script-src has an unsafe-inline/eval escape hatch');
  if (!framed) console.log('    ✗ framing not fully blocked (need XFO:DENY + frame-ancestors none)');
  const sd = (csp.match(/script-src ([^;]*)/) || [])[1] || '';
  console.log('    script-src:', sd.slice(0, 90) + (sd.length > 90 ? '…' : ''));
}
console.log(bad ? '\nHEADER VERIFY FAILED' : `\nHEADER VERIFY PASS (${env}) — CSP present, script hatches absent, framing blocked`);
process.exit(bad ? 1 : 0);
