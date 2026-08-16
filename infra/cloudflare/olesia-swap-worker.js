// Cloudflare Worker — routes the Olesia atomic-swap UI onto a same-site origin as the wallet and
// injects the window.olesia provider WITHOUT modifying the swap engine tree.
//
// Deploy on route  swap.olesia.io/*  (recommended: a subdomain, so the swap page's root-relative
// asset imports like ./eth-wallet.js and its /api/swap/v1 calls all resolve to the swap server).
// It proxies every path to the swap origin and, for HTML responses only, appends one <script>
// that loads the provider from the wallet origin. The provider (app.olesia.io/olesia-provider.js)
// opens the wallet's connect popup and relays olesia_getAccount / olesia_signPsbt over postMessage.
//
// Config (wrangler.toml [vars] or dashboard): SWAP_ORIGIN = the internal origin the Worker can
// reach the swap server at — e.g. a Cloudflare Tunnel public hostname bound to 127.0.0.1:8975
// (cloudflared), such as "https://swap-origin.olesia.io". Keep that hostname OUT of this Worker's
// route so there is no proxy loop.
export default {
  async fetch(request, env) {
    const SWAP_ORIGIN = env.SWAP_ORIGIN;                 // e.g. https://swap-origin.olesia.io -> tunnel -> 127.0.0.1:8975
    const PROVIDER = 'https://app.olesia.io/olesia-provider.js';
    if (!SWAP_ORIGIN) return new Response('SWAP_ORIGIN not configured', { status: 500 });

    const url = new URL(request.url);
    const target = SWAP_ORIGIN + url.pathname + url.search;
    const resp = await fetch(new Request(target, request));

    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return resp;          // pass through assets + /api/* unchanged

    // Inject exactly one provider <script> into the page <head>. The swap page has no CSP, and
    // this changes nothing else — the manual-paste fallback still works if the script is blocked.
    return new HTMLRewriter()
      .on('head', { element(el) { el.append(`<script src="${PROVIDER}" defer></script>`, { html: true }); } })
      .transform(new Response(resp.body, resp));
  },
};

// Example wrangler.toml:
//   name = "olesia-swap"
//   main = "olesia-swap-worker.js"
//   compatibility_date = "2024-11-01"
//   routes = [{ pattern = "swap.olesia.io/*", zone_name = "olesia.io" }]
//   [vars]
//   SWAP_ORIGIN = "https://swap-origin.olesia.io"
