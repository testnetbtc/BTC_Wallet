// Content-Security-Policy tooling shared by every Olesia property.
//
// The security-critical pages ship as a single self-contained HTML with a couple
// of INLINE <script> blocks and no external scripts. Rather than allow
// `script-src 'unsafe-inline'` (which would let ANY injected inline script run),
// we hash each inline block (sha256, base64) and pin those exact hashes. Result:
// only the reviewed script bytes can execute; a single changed byte fails the CSP.
//
// This CSP is emitted as a REAL HTTP response header (Cloudflare `_headers`), which
// is the only place `frame-ancestors` is enforced, and mirrored into the <meta>
// tag as defence-in-depth. Verified externally after deploy (see tools/verify-headers.mjs).
import { createHash } from 'node:crypto';

const sha256b64 = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('base64');

// exact content between each <script ...> ... </script> (what the browser hashes)
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) out.push(`'sha256-${sha256b64(m[1])}'`);
  return out;
}

// A locked-down CSP. `connect` lists the ONLY hosts fetch() may reach.
// `style: 'unsafe-inline'` is the one deliberate allowance — inline style="..."
// ATTRIBUTES cannot be hashed and carry no script-execution risk; documented in
// docs/THREAT_MODEL.md. There is NO 'unsafe-inline'/'unsafe-eval' for scripts.
export function buildCSP({ scriptHashes = [], scriptHosts = [], connect = "'none'", img = 'data:', manifest = false, frame = "'none'", formAction = "'none'" }) {
  const script = [...scriptHashes, ...scriptHosts];
  return [
    "default-src 'none'",
    `script-src ${script.length ? script.join(' ') : "'none'"}`,
    "style-src 'unsafe-inline'",
    `img-src ${img}`,
    'font-src data:',
    ...(manifest ? ["manifest-src 'self'"] : []),
    `connect-src ${connect}`,
    `frame-src ${frame}`,
    'base-uri \'none\'',
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

// Full security-header set. HSTS assumes HTTPS-only hosting (Cloudflare Pages).
export function securityHeaders(csp) {
  return {
    ...(csp ? { 'Content-Security-Policy': csp } : {}),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), interest-cohort=()',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  };
}

// Render one Cloudflare `_headers` rule block for a path glob.
export function headersBlock(path, csp) {
  return `${path}\n` + Object.entries(securityHeaders(csp)).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n';
}

// Harden one built HTML file in place: compute inline-script hashes, rewrite the
// <meta> CSP to match (no script 'unsafe-inline'), and write the sibling `_headers`
// with the full CSP + security headers. Returns the CSP for logging. Deterministic.
import { readFileSync, writeFileSync } from 'node:fs';
export function hardenHtml({ htmlPath, headersPath, connect = "'none'", img = 'data:', manifest = false, extraHeaderBlocks = '' }) {
  let html = readFileSync(htmlPath, 'utf8');
  const csp = buildCSP({ scriptHashes: inlineScriptHashes(html), connect, img, manifest });
  html = injectMetaCSP(html, csp);
  writeFileSync(htmlPath, html);
  writeFileSync(headersPath, headersBlock('/*', csp) + (extraHeaderBlocks ? '\n' + extraHeaderBlocks : ''));
  return { csp, scriptHashes: inlineScriptHashes(html).length };
}

// Replace the <meta http-equiv="Content-Security-Policy" content="..."> to match
// the header CSP — but WITHOUT frame-ancestors, which browsers ignore (and warn
// about) in a <meta>. Anti-framing is enforced by the HTTP header + X-Frame-Options.
export function injectMetaCSP(html, csp) {
  const metaCSP = csp.replace(/;?\s*frame-ancestors [^;]*/, '');
  return html.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/, `$1${metaCSP}$2`);
}
