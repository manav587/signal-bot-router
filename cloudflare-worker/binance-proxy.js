/**
 * Cloudflare Worker — Binance Futures API Proxy
 *
 * Routes Binance API calls through Cloudflare's global edge network
 * to avoid geo-restrictions (HTTP 451) from US-based cloud servers.
 *
 * The relay sends signed requests here instead of directly to Binance.
 * This Worker forwards them transparently and returns the response.
 *
 * Security: requires X-Proxy-Token header matching the PROXY_TOKEN secret.
 *
 * Deploy: Cloudflare Dashboard → Workers → Create → paste this code
 * Set secret: Settings → Variables → PROXY_TOKEN = (generate a random string)
 *
 * Relay config: set BINANCE_PROXY_URL=https://your-worker.workers.dev in Render env vars
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'X-MBX-APIKEY, X-Proxy-Token, Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Auth check — reject requests without valid proxy token
    const proxyToken = request.headers.get('X-Proxy-Token');
    if (!env.PROXY_TOKEN || proxyToken !== env.PROXY_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Health check
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, proxy: 'binance-futures', region: request.cf?.colo || 'unknown' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // IP check — discover this Worker's outbound IP for Binance API key whitelisting
    if (url.pathname === '/ip') {
      try {
        const ipRes = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipRes.json();
        return new Response(JSON.stringify({ ip: ipData.ip, region: request.cf?.colo || 'unknown' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Forward to Binance Futures API
    const binanceUrl = `https://fapi.binance.com${url.pathname}${url.search}`;

    // Copy relevant headers (API key, content type)
    const forwardHeaders = new Headers();
    const apiKey = request.headers.get('X-MBX-APIKEY');
    if (apiKey) forwardHeaders.set('X-MBX-APIKEY', apiKey);
    forwardHeaders.set('Content-Type', request.headers.get('Content-Type') || 'application/json');

    try {
      const binanceRes = await fetch(binanceUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: request.method !== 'GET' ? await request.text() : undefined,
      });

      const body = await binanceRes.text();

      return new Response(body, {
        status: binanceRes.status,
        headers: {
          'Content-Type': binanceRes.headers.get('Content-Type') || 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Proxy-Region': request.cf?.colo || 'unknown',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
