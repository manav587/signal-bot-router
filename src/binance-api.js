/**
 * Binance USDT-M Futures API Client (read-only)
 * Direct exchange access for position verification, PnL, and margin data.
 * Used by Signal Bot Router as ground truth — Gainium API is the secondary source.
 *
 * Auth: HMAC-SHA256 signature in query string per Binance docs.
 *   signature = HMAC-SHA256(secret, queryString)
 *
 * Env vars required:
 *   BINANCE_API_KEY    — from Binance API Management (read-only, no IP restriction)
 *   BINANCE_API_SECRET — the HMAC secret paired with the key
 */

const crypto = require('crypto');

const BASE_URL = 'https://fapi.binance.com';
const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

// ── Logging (uses same IST format as server.js / gainium-api.js) ──────────

function istTimestamp() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function log(msg) {
  console.log(`[${istTimestamp()}] [binance-api] ${msg}`);
}

// ── HMAC Signing ──────────────────────────────────────────────────────────

function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

/**
 * Build a signed query string for Binance Futures API.
 * Appends timestamp and signature to the provided params.
 */
function signedQuery(params = {}) {
  params.timestamp = Date.now().toString();
  params.recvWindow = '5000';
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const signature = sign(qs);
  return `${qs}&signature=${signature}`;
}

// ── API Calls ─────────────────────────────────────────────────────────────

/**
 * GET open positions from Binance Futures.
 * Returns array of positions with non-zero positionAmt.
 * Each position: { symbol, positionAmt, entryPrice, markPrice, unRealizedProfit,
 *                  leverage, marginType, liquidationPrice, positionSide, notional }
 *
 * @param {string} [symbol] — Optional: filter to one pair (e.g. 'SOLUSDT')
 * @returns {Array} — Open positions (filtered to non-zero size) or empty array on error
 */
async function getOpenPositions(symbol) {
  const params = {};
  if (symbol) params.symbol = symbol;
  const qs = signedQuery(params);
  const url = `${BASE_URL}/fapi/v2/positionRisk?${qs}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-MBX-APIKEY': API_KEY },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      log(`getOpenPositions error (${res.status}): ${text.substring(0, 300)}`);
      return [];
    }

    const positions = await res.json();
    // Filter to non-zero positions only
    const open = positions.filter(p => parseFloat(p.positionAmt) !== 0);
    log(`getOpenPositions: ${open.length} open position(s) out of ${positions.length} total`);
    return open;
  } catch (err) {
    log(`getOpenPositions error: ${err.message}`);
    return [];
  }
}

/**
 * GET futures account info — wallet balance, margin, unrealized PnL.
 * Returns { totalWalletBalance, totalUnrealizedProfit, availableBalance, totalMarginBalance }
 * or null on error.
 */
async function getAccountInfo() {
  const qs = signedQuery();
  const url = `${BASE_URL}/fapi/v2/account?${qs}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-MBX-APIKEY': API_KEY },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      log(`getAccountInfo error (${res.status}): ${text.substring(0, 300)}`);
      return null;
    }

    const data = await res.json();
    const summary = {
      totalWalletBalance: parseFloat(data.totalWalletBalance),
      totalUnrealizedProfit: parseFloat(data.totalCrossUnPnl),
      availableBalance: parseFloat(data.availableBalance),
      totalMarginBalance: parseFloat(data.totalMarginBalance),
    };
    log(`getAccountInfo: wallet=$${summary.totalWalletBalance.toFixed(2)}, unrealizedPnL=$${summary.totalUnrealizedProfit.toFixed(2)}, available=$${summary.availableBalance.toFixed(2)}`);
    return summary;
  } catch (err) {
    log(`getAccountInfo error: ${err.message}`);
    return null;
  }
}

/**
 * Build a position summary keyed by base asset (SOL, ETH, XRP, BTC).
 * Merges LONG and SHORT positions for each symbol.
 * Used by startup recovery and revalidation to know ground truth.
 *
 * @returns {Map<string, { symbol, side, size, entryPrice, markPrice, pnl, leverage, liquidationPrice }>}
 *          Key = base asset (e.g. 'SOL'), Value = position details. Only non-zero positions.
 */
async function getPositionMap() {
  const positions = await getOpenPositions();
  const map = new Map();

  for (const pos of positions) {
    const size = parseFloat(pos.positionAmt);
    if (size === 0) continue;

    // Extract base asset: SOLUSDT → SOL, ETHUSDT → ETH
    const base = pos.symbol.replace('USDT', '');
    const side = size > 0 ? 'LONG' : 'SHORT';

    map.set(base, {
      symbol: pos.symbol,
      side,
      size: Math.abs(size),
      entryPrice: parseFloat(pos.entryPrice),
      markPrice: parseFloat(pos.markPrice),
      pnl: parseFloat(pos.unRealizedProfit),
      leverage: parseInt(pos.leverage),
      liquidationPrice: parseFloat(pos.liquidationPrice),
      marginType: pos.marginType,
      notional: parseFloat(pos.notional),
    });
  }

  log(`getPositionMap: ${map.size} active position(s)${map.size > 0 ? ' — ' + [...map.entries()].map(([k, v]) => `${k} ${v.side} $${v.pnl.toFixed(2)}`).join(', ') : ''}`);
  return map;
}

// ── Public API ────────────────────────────────────────────────────────────

function isConfigured() {
  return API_KEY.length > 0 && API_SECRET.length > 0;
}

module.exports = {
  isConfigured,
  getOpenPositions,
  getAccountInfo,
  getPositionMap,
};
