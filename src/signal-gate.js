/**
 * Signal Gate (v1.6.0)
 *
 * Server-side signal validation using technical indicators.
 * Fetches candles from Binance public API, calculates EMA and RSI,
 * and gates crossover signals before they reach Gainium.
 *
 * No API key needed — Binance /api/v3/klines is public.
 */

const { EMA, RSI } = require('trading-signals');

// ── Configuration ─────────────────────────────────────────────────────────
// These thresholds can be tuned without touching TradingView.
const CONFIG = {
  // Daily 50 EMA trend filter
  trendEma: {
    period: 50,
    timeframe: '1d',      // Daily candles for trend
    candlesNeeded: 60,     // Need 60 daily candles to stabilize a 50-period EMA
  },

  // RSI momentum confirmation (4h timeframe — same as crossover chart)
  rsi: {
    period: 14,
    timeframe: '4h',
    candlesNeeded: 20,     // Need 20 candles to stabilize a 14-period RSI
    longMinimum: 40,       // Only go LONG if RSI > 40
    shortMaximum: 60,      // Only go SHORT if RSI < 60
  },

  // Binance API
  binanceBaseUrl: 'https://api.binance.com',
  fetchTimeout: 5000,      // 5s timeout for Binance API calls
};

// ── Pair name mapping ────────────────────────────────────────────────────
// BOT_MAP uses names like "ETH Long v2" → we need "ETHUSDT" for Binance
const PAIR_TO_SYMBOL = {
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
};

/**
 * Fetch OHLC candles from Binance public API.
 * @param {string} symbol - e.g. 'ETHUSDT'
 * @param {string} interval - e.g. '1d', '4h'
 * @param {number} limit - number of candles
 * @returns {Array<{open: number, high: number, low: number, close: number, time: number}>}
 */
async function fetchCandles(symbol, interval, limit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeout);

  try {
    const url = `${CONFIG.binanceBaseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Binance API ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();

    // Binance klines format: [openTime, open, high, low, close, volume, closeTime, ...]
    return data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`Binance candle fetch failed for ${symbol} ${interval}: ${err.message}`);
  }
}

/**
 * Calculate EMA for a series of candle close prices.
 * @param {number[]} closes - array of close prices
 * @param {number} period - EMA period
 * @returns {number|null} - current EMA value, or null if not enough data
 */
function calculateEMA(closes, period) {
  const ema = new EMA(period);
  for (const price of closes) {
    ema.update(price);
  }
  return ema.isStable ? parseFloat(ema.getResult().toFixed(6)) : null;
}

/**
 * Calculate RSI for a series of candle close prices.
 * @param {number[]} closes - array of close prices
 * @param {number} period - RSI period
 * @returns {number|null} - current RSI value (0-100), or null if not enough data
 */
function calculateRSI(closes, period) {
  const rsi = new RSI(period);
  for (const price of closes) {
    rsi.update(price);
  }
  return rsi.isStable ? parseFloat(rsi.getResult().toFixed(2)) : null;
}

/**
 * Validate a crossover signal against trend and momentum filters.
 *
 * @param {string} pair - e.g. 'ETH', 'SOL', 'XRP'
 * @param {string} direction - 'LONG' or 'SHORT'
 * @returns {{ allowed: boolean, reason: string, data: object }}
 */
async function validateSignal(pair, direction) {
  const symbol = PAIR_TO_SYMBOL[pair];
  if (!symbol) {
    return { allowed: true, reason: 'Unknown pair — passing through', data: {} };
  }

  const data = {};

  try {
    // Fetch daily candles for trend EMA and 4h candles for RSI in parallel
    const [dailyCandles, fourHourCandles] = await Promise.all([
      fetchCandles(symbol, CONFIG.trendEma.timeframe, CONFIG.trendEma.candlesNeeded),
      fetchCandles(symbol, CONFIG.rsi.timeframe, CONFIG.rsi.candlesNeeded),
    ]);

    // Calculate daily 50 EMA
    const dailyCloses = dailyCandles.map(c => c.close);
    const currentPrice = dailyCloses[dailyCloses.length - 1];
    const ema50 = calculateEMA(dailyCloses, CONFIG.trendEma.period);

    // Calculate 4h RSI(14)
    const fourHourCloses = fourHourCandles.map(c => c.close);
    const rsi14 = calculateRSI(fourHourCloses, CONFIG.rsi.period);

    data.currentPrice = currentPrice;
    data.ema50 = ema50;
    data.rsi14 = rsi14;
    data.priceVsEma = ema50 ? (currentPrice > ema50 ? 'ABOVE' : 'BELOW') : 'UNKNOWN';

    // ── Gate 1: Daily 50 EMA trend filter ──────────────────────────────
    if (ema50 !== null) {
      if (direction === 'LONG' && currentPrice < ema50) {
        return {
          allowed: false,
          reason: `TREND FILTER: Price $${currentPrice.toFixed(2)} is BELOW daily 50 EMA $${ema50.toFixed(2)} — bullish signal rejected`,
          data,
        };
      }
      if (direction === 'SHORT' && currentPrice > ema50) {
        return {
          allowed: false,
          reason: `TREND FILTER: Price $${currentPrice.toFixed(2)} is ABOVE daily 50 EMA $${ema50.toFixed(2)} — bearish signal rejected`,
          data,
        };
      }
    }

    // ── Gate 2: RSI momentum confirmation ──────────────────────────────
    if (rsi14 !== null) {
      if (direction === 'LONG' && rsi14 < CONFIG.rsi.longMinimum) {
        return {
          allowed: false,
          reason: `RSI FILTER: RSI(14) = ${rsi14} < ${CONFIG.rsi.longMinimum} — weak momentum, bullish signal rejected`,
          data,
        };
      }
      if (direction === 'SHORT' && rsi14 > CONFIG.rsi.shortMaximum) {
        return {
          allowed: false,
          reason: `RSI FILTER: RSI(14) = ${rsi14} > ${CONFIG.rsi.shortMaximum} — strong momentum, bearish signal rejected`,
          data,
        };
      }
    }

    // Both gates passed
    return {
      allowed: true,
      reason: `PASSED: Price $${currentPrice.toFixed(2)} ${data.priceVsEma} EMA50 $${ema50?.toFixed(2) || '?'}, RSI(14) = ${rsi14 || '?'}`,
      data,
    };

  } catch (err) {
    // If Binance is down or candle fetch fails, let the signal through.
    // Better to trade on a potentially bad signal than to block all trading
    // because of an API outage.
    return {
      allowed: true,
      reason: `GATE ERROR (passing through): ${err.message}`,
      data,
    };
  }
}

/**
 * Get current gate configuration (for health/status endpoints).
 */
function getConfig() {
  return {
    trendEma: `${CONFIG.trendEma.period}-period EMA on ${CONFIG.trendEma.timeframe}`,
    rsi: `${CONFIG.rsi.period}-period RSI on ${CONFIG.rsi.timeframe} (LONG > ${CONFIG.rsi.longMinimum}, SHORT < ${CONFIG.rsi.shortMaximum})`,
  };
}

module.exports = { validateSignal, getConfig, CONFIG };
