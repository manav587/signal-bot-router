/**
 * Funding Rate Strategy (v1.0.0) — STANDBY
 *
 * Mean-reversion strategy based on Binance Futures funding rate.
 * When retail is overleveraged in one direction (extreme funding rate),
 * trade against them — the market tends to correct.
 *
 * Signal logic:
 *   Funding rate strongly positive (>0.03%) → SHORT (retail overleveraged long)
 *   Funding rate strongly negative (<-0.01%) → LONG (retail overleveraged short)
 *   OI confirmation optional — rising OI with extreme funding = stronger signal
 *
 * Uses Binance Futures public API (no key needed):
 *   /fapi/v1/premiumIndex  — current + predicted funding rate
 *   /fapi/v1/openInterest  — current open interest
 */

// ── Configuration ─────────────────────────────────────────────────────────
const CONFIG = {
  pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],

  // Funding rate thresholds (expressed as decimals, not percentages)
  // Normal funding = 0.0001 (0.01%). These trigger on extremes only.
  funding: {
    longTrigger: -0.0001,    // Funding < -0.01% → LONG (shorts paying, retail short-heavy)
    shortTrigger: 0.0003,    // Funding > 0.03% → SHORT (longs paying, retail long-heavy)
  },

  // API providers — ordered by reliability from US cloud IPs
  // Binance Futures is geo-blocked from US cloud → Bybit as primary
  providers: [
    { name: 'Bybit', type: 'bybit', baseUrl: 'https://api.bybit.com' },
    { name: 'Binance', type: 'binance', baseUrl: 'https://fapi.binance.com' },
    { name: 'Binance-Mirror', type: 'binance', baseUrl: 'https://fapi1.binance.com' },
  ],
  fetchTimeout: 5000,

  // Cooldown — don't re-signal the same pair/direction within one funding period
  cooldownMs: 8 * 60 * 60 * 1000, // 8 hours
};

// ── Pair name mapping (matches signal-gate.js) ────────────────────────────
const SYMBOL_TO_PAIR = {
  BTCUSDT: 'BTC',
  ETHUSDT: 'ETH',
  SOLUSDT: 'SOL',
  XRPUSDT: 'XRP',
};

// ── Cooldown tracking (in-memory, resets on deploy) ───────────────────────
const lastSignals = {};

// ── Data fetching ─────────────────────────────────────────────────────────

/**
 * Fetch funding rate from Bybit.
 * Uses /v5/market/tickers which returns current funding rate + mark price.
 */
async function fetchFromBybit(baseUrl, symbol) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeout);

  try {
    const url = `${baseUrl}/v5/market/tickers?category=linear&symbol=${symbol}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`Bybit error: ${json.retMsg}`);

    const item = json.result.list[0];
    if (!item) throw new Error('Empty ticker list');

    return {
      symbol: item.symbol,
      markPrice: parseFloat(item.markPrice),
      lastFundingRate: parseFloat(item.fundingRate),
      nextFundingTime: parseInt(item.nextFundingTime),
      openInterest: parseFloat(item.openInterest),
      openInterestValue: parseFloat(item.openInterestValue || 0),
      provider: 'Bybit',
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Fetch funding rate from Binance Futures.
 * Uses /fapi/v1/premiumIndex for funding rate + mark price.
 */
async function fetchFromBinance(baseUrl, symbol) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeout);

  try {
    const url = `${baseUrl}/fapi/v1/premiumIndex?symbol=${symbol}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    return {
      symbol: data.symbol,
      markPrice: parseFloat(data.markPrice),
      lastFundingRate: parseFloat(data.lastFundingRate),
      nextFundingTime: data.nextFundingTime,
      openInterest: null, // Separate endpoint on Binance
      provider: 'Binance',
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Fetch funding rate + market data with provider fallback.
 * Returns null if all providers fail.
 */
async function fetchFundingData(symbol) {
  const errors = [];

  for (const provider of CONFIG.providers) {
    try {
      if (provider.type === 'bybit') {
        return await fetchFromBybit(provider.baseUrl, symbol);
      } else {
        return await fetchFromBinance(provider.baseUrl, symbol);
      }
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  console.log(`[FUNDING] All providers failed for ${symbol}: ${errors.join('; ')}`);
  return null;
}

// ── Signal logic ──────────────────────────────────────────────────────────

/**
 * Check a single pair for a funding rate signal.
 *
 * @param {string} symbol - e.g. 'SOLUSDT'
 * @returns {{ signal: string|null, pair: string, data: object }}
 */
async function checkPair(symbol) {
  const pair = SYMBOL_TO_PAIR[symbol] || symbol;

  const marketData = await fetchFundingData(symbol);

  if (!marketData) {
    return {
      signal: null,
      pair,
      data: { symbol, error: 'Failed to fetch funding rate from all providers' },
    };
  }

  const data = {
    symbol,
    pair,
    markPrice: marketData.markPrice,
    fundingRate: marketData.lastFundingRate,
    fundingPct: (marketData.lastFundingRate * 100).toFixed(4) + '%',
    nextFundingTime: new Date(marketData.nextFundingTime).toISOString(),
    openInterest: marketData.openInterest,
    openInterestUsd: marketData.openInterest ? `$${(marketData.openInterest * marketData.markPrice / 1e6).toFixed(1)}M` : null,
    provider: marketData.provider,
  };

  // Check cooldown
  const lastSignal = lastSignals[symbol];
  if (lastSignal && Date.now() - lastSignal.time < CONFIG.cooldownMs) {
    data.cooldown = true;
    data.cooldownUntil = new Date(lastSignal.time + CONFIG.cooldownMs).toISOString();
    data.lastDirection = lastSignal.direction;
    return { signal: null, pair, data };
  }

  // Determine signal direction
  let signal = null;

  if (funding.lastFundingRate > CONFIG.funding.shortTrigger) {
    signal = 'SHORT';
    data.reason = `Funding ${data.fundingPct} > ${(CONFIG.funding.shortTrigger * 100).toFixed(2)}% threshold — retail overleveraged long → SHORT`;
  } else if (funding.lastFundingRate < CONFIG.funding.longTrigger) {
    signal = 'LONG';
    data.reason = `Funding ${data.fundingPct} < ${(CONFIG.funding.longTrigger * 100).toFixed(2)}% threshold — retail overleveraged short → LONG`;
  } else {
    data.reason = `Funding ${data.fundingPct} — within normal range (${(CONFIG.funding.longTrigger * 100).toFixed(2)}% to ${(CONFIG.funding.shortTrigger * 100).toFixed(2)}%), no signal`;
  }

  return { signal, pair, data };
}

/**
 * Run the funding rate check across all configured pairs.
 * Returns array of results for each pair.
 */
async function checkAllPairs() {
  const results = await Promise.all(
    CONFIG.pairs.map(symbol => checkPair(symbol))
  );
  return results;
}

/**
 * Record that a signal was acted on (for cooldown tracking).
 */
function recordSignal(symbol, direction) {
  lastSignals[symbol] = { direction, time: Date.now() };
}

/**
 * Get current configuration (for status endpoints).
 */
function getConfig() {
  return {
    pairs: CONFIG.pairs,
    longTrigger: `Funding < ${(CONFIG.funding.longTrigger * 100).toFixed(2)}%`,
    shortTrigger: `Funding > ${(CONFIG.funding.shortTrigger * 100).toFixed(2)}%`,
    cooldown: `${CONFIG.cooldownMs / (60 * 60 * 1000)}h between signals per pair`,
    status: 'STANDBY — not triggering trades',
  };
}

module.exports = { checkAllPairs, checkPair, recordSignal, getConfig, CONFIG };
