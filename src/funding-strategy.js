/**
 * Funding Rate Strategy (v1.1.0) — STANDBY
 *
 * Mean-reversion strategy based on Binance Futures funding rate.
 * When retail is overleveraged in one direction (extreme funding rate),
 * trade against them — the market tends to correct.
 *
 * Signal logic:
 *   Funding rate strongly positive (>0.03%) → SHORT (retail overleveraged long)
 *   Funding rate strongly negative (<-0.01%) → LONG (retail overleveraged short)
 *
 * Data source: CryptoCompare (CCData) futures funding rate API
 *   Cloud-friendly — works from Render/US cloud IPs (no geo-blocking)
 *   Same provider family as signal-gate.js candle data
 *   Single call returns all 4 pairs at once
 *   No API key required for basic access
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

  // CryptoCompare (CCData) futures API — cloud-friendly, no geo-blocking
  ccdata: {
    baseUrl: 'https://data-api.cryptocompare.com',
    market: 'binance',
    // Map our symbols to CCData instrument names
    instruments: {
      BTCUSDT: 'BTC-USDT-VANILLA-PERPETUAL',
      ETHUSDT: 'ETH-USDT-VANILLA-PERPETUAL',
      SOLUSDT: 'SOL-USDT-VANILLA-PERPETUAL',
      XRPUSDT: 'XRP-USDT-VANILLA-PERPETUAL',
    },
  },
  fetchTimeout: 8000,

  // Cooldown — don't re-signal the same pair/direction within one funding period
  cooldownMs: 8 * 60 * 60 * 1000, // 8 hours
};

// ── Pair name mapping ────────────────────────────────────────────────────
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
 * Fetch funding rates for ALL pairs in a single API call from CryptoCompare.
 * Returns a map of symbol → { fundingRate, timestamp } or null on failure.
 */
async function fetchAllFundingRates() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeout);

  const instruments = Object.values(CONFIG.ccdata.instruments).join(',');
  const url = `${CONFIG.ccdata.baseUrl}/futures/v1/latest/funding-rate/tick?market=${CONFIG.ccdata.market}&instruments=${instruments}`;

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (!json.Data) throw new Error('No Data field in response');

    // Map CCData instrument names back to our symbols
    const result = {};
    for (const [symbol, ccInstrument] of Object.entries(CONFIG.ccdata.instruments)) {
      const data = json.Data[ccInstrument];
      if (data) {
        result[symbol] = {
          fundingRate: data.VALUE,                    // e.g. 1.977e-05 = 0.001977%
          timestamp: data.VALUE_LAST_UPDATE_TS * 1000, // Convert to ms
          provider: 'CCData',
        };
      }
    }

    return result;
  } catch (err) {
    clearTimeout(timeout);
    console.log(`[FUNDING] CCData fetch failed: ${err.message}`);
    return null;
  }
}

// ── Signal logic ──────────────────────────────────────────────────────────

/**
 * Check a single pair for a funding rate signal.
 *
 * @param {string} symbol - e.g. 'SOLUSDT'
 * @param {object} allRates - pre-fetched rates from fetchAllFundingRates()
 * @returns {{ signal: string|null, pair: string, data: object }}
 */
function checkPairFromRates(symbol, allRates) {
  const pair = SYMBOL_TO_PAIR[symbol] || symbol;

  if (!allRates || !allRates[symbol]) {
    return {
      signal: null,
      pair,
      data: { symbol, error: 'No funding rate data available' },
    };
  }

  const rateData = allRates[symbol];
  const fundingRate = rateData.fundingRate;

  const data = {
    symbol,
    pair,
    fundingRate,
    fundingPct: (fundingRate * 100).toFixed(4) + '%',
    lastUpdate: new Date(rateData.timestamp).toISOString(),
    provider: rateData.provider,
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

  if (fundingRate > CONFIG.funding.shortTrigger) {
    signal = 'SHORT';
    data.reason = `Funding ${data.fundingPct} > ${(CONFIG.funding.shortTrigger * 100).toFixed(2)}% threshold — retail overleveraged long → SHORT`;
  } else if (fundingRate < CONFIG.funding.longTrigger) {
    signal = 'LONG';
    data.reason = `Funding ${data.fundingPct} < ${(CONFIG.funding.longTrigger * 100).toFixed(2)}% threshold — retail overleveraged short → LONG`;
  } else {
    data.reason = `Funding ${data.fundingPct} — within normal range (${(CONFIG.funding.longTrigger * 100).toFixed(2)}% to ${(CONFIG.funding.shortTrigger * 100).toFixed(2)}%), no signal`;
  }

  return { signal, pair, data };
}

/**
 * Legacy single-pair check (used by /funding-check/:symbol endpoint).
 */
async function checkPair(symbol) {
  const allRates = await fetchAllFundingRates();
  return checkPairFromRates(symbol, allRates);
}

/**
 * Run the funding rate check across all configured pairs.
 * Single API call for all pairs, then evaluate each.
 */
async function checkAllPairs() {
  const allRates = await fetchAllFundingRates();

  return CONFIG.pairs.map(symbol => checkPairFromRates(symbol, allRates));
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
    provider: 'CCData (data-api.cryptocompare.com)',
    status: 'STANDBY — not triggering trades',
  };
}

module.exports = { checkAllPairs, checkPair, recordSignal, getConfig, CONFIG };
