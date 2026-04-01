/**
 * Signal Gate (v1.8.0)
 *
 * Server-side signal validation using technical indicators + smart money data.
 * Fetches candles from Binance public API, calculates EMA and RSI,
 * and gates crossover signals before they reach Gainium.
 *
 * v1.8.0: Added Gate 5 — Smart Money filter using Binance Futures top trader
 *         long/short position ratio. Blocks trades when whale positioning
 *         strongly disagrees with signal direction.
 *
 * v1.7.0: Added 4H EMA 9/21 short-term trend filter and RSI direction check.
 *         Fixes timeframe mismatch where daily trend was bearish but intraday
 *         price was rallying, causing shorts to get ground up.
 *
 * No API key needed — Binance /api/v3/klines and /futures/data/* are public.
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

  // 4H EMA 9/21 short-term trend filter — must agree with daily trend
  shortTermEma: {
    fast: 9,
    slow: 21,
    timeframe: '4h',
    candlesNeeded: 30,     // Need 30 candles to stabilize a 21-period EMA
  },

  // RSI momentum confirmation (4h timeframe — same as crossover chart)
  rsi: {
    period: 14,
    timeframe: '4h',
    candlesNeeded: 20,     // Need 20 candles to stabilize a 14-period RSI
    longMinimum: 40,       // Only go LONG if RSI > 40
    shortMaximum: 60,      // Only go SHORT if RSI < 60
    slopeCandles: 3,       // Compare RSI now vs N candles ago for direction
  },

  // Smart Money gate — Binance Futures top trader long/short ratio
  // Uses /futures/data/topLongShortPositionRatio (public, no API key)
  // Only blocks when whale positioning STRONGLY disagrees with signal
  smartMoney: {
    period: '4h',             // Match our trading timeframe
    longMinRatio: 0.35,       // Block LONG if top traders < 35% long (whales heavily short)
    shortMaxRatio: 0.65,      // Block SHORT if top traders > 65% long (whales heavily long)
    providers: [
      'https://fapi.binance.com',    // Primary — may be geo-blocked from some cloud IPs
      'https://fapi1.binance.com',   // Mirror
    ],
  },

  // Data providers — ordered by reliability from US cloud IPs
  // Binance Data Vision = public read-only data API (works from US cloud)
  // CryptoCompare = cloud-friendly aggregator (needs API key from server IPs)
  // Standard Binance/Bybit APIs are geo-blocked from US cloud (451/403)
  providers: [
    { name: 'Binance-Data', type: 'binance', baseUrl: 'https://data-api.binance.vision' },
    { name: 'CryptoCompare', type: 'cryptocompare', baseUrl: 'https://min-api.cryptocompare.com' },
    { name: 'Binance', type: 'binance', baseUrl: 'https://api.binance.com' },
    { name: 'Bybit', type: 'bybit', baseUrl: 'https://api.bybit.com' },
  ],
  fetchTimeout: 5000,      // 5s timeout per API call
};

// ── Pair name mapping ────────────────────────────────────────────────────
const PAIR_TO_SYMBOL = {
  ETH: { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT' },
  SOL: { symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT' },
  XRP: { symbol: 'XRPUSDT', base: 'XRP', quote: 'USDT' },
  BTC: { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT' },
};

// ── CryptoCompare interval mapping ───────────────────────────────────────
// CryptoCompare has separate endpoints per timeframe
const CC_ENDPOINTS = {
  '1d': 'histoday',
  '4h': 'histohour',
  '1h': 'histohour',
};
const CC_AGGREGATE = {
  '1d': 1,
  '4h': 4,    // aggregate 4 hourly candles
  '1h': 1,
};

/**
 * Fetch OHLC candles from CryptoCompare.
 * Cloud-friendly — no geo-blocking from Render/AWS/GCP IPs.
 */
async function fetchCandlesCryptoCompare(baseUrl, pairInfo, interval, limit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeout);

  try {
    const endpoint = CC_ENDPOINTS[interval] || 'histoday';
    const aggregate = CC_AGGREGATE[interval] || 1;
    const apiKey = process.env.CRYPTOCOMPARE_API_KEY || '';
    const keyParam = apiKey ? `&api_key=${apiKey}` : '';
    const url = `${baseUrl}/data/v2/${endpoint}?fsym=${pairInfo.base}&tsym=${pairInfo.quote}&limit=${limit}&aggregate=${aggregate}${keyParam}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`CryptoCompare API ${res.status}`);

    const json = await res.json();
    if (json.Response !== 'Success') throw new Error(`CryptoCompare error: ${json.Message}`);

    // CryptoCompare format: { time, open, high, low, close, volumefrom, volumeto }
    // Returned in ASC order (oldest first) — no reversal needed
    return json.Data.Data.map(k => ({
      time: k.time * 1000,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volumefrom,
    }));
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Bybit interval mapping ────────────────────────────────────────────────
// Bybit uses different interval names than Binance
const BYBIT_INTERVALS = {
  '1d': 'D',
  '4h': '240',
  '1h': '60',
  '15m': '15',
};

/**
 * Fetch OHLC candles from Bybit public API.
 * Bybit returns data in DESCENDING order (newest first) — we reverse it.
 */
async function fetchCandlesBybit(baseUrl, symbol, interval, limit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeout);

  try {
    const bybitInterval = BYBIT_INTERVALS[interval] || interval;
    const url = `${baseUrl}/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Bybit API ${res.status}`);

    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`Bybit error: ${json.retMsg}`);

    // Bybit format: ["timestamp", "open", "high", "low", "close", "volume", "turnover"]
    // Returned in DESC order — reverse to ASC (oldest first)
    return json.result.list
      .map(k => ({
        time: parseInt(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }))
      .reverse();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Fetch OHLC candles from Binance public API.
 */
async function fetchCandlesBinance(baseUrl, symbol, interval, limit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeout);

  try {
    const url = `${baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Binance API ${res.status}`);

    const data = await res.json();
    // Binance format: [openTime, open, high, low, close, volume, closeTime, ...]
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
    throw err;
  }
}

/**
 * Fetch candles with automatic provider fallback.
 * Tries CryptoCompare first (cloud-friendly), falls back to Bybit/Binance.
 *
 * @param {object} pairInfo - { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT' }
 * @param {string} interval - e.g. '1d', '4h'
 * @param {number} limit - number of candles
 * @returns {Array<{open, high, low, close, volume, time}>}
 */
async function fetchCandles(pairInfo, interval, limit) {
  const errors = [];

  for (const provider of CONFIG.providers) {
    try {
      let candles;
      if (provider.type === 'cryptocompare') {
        candles = await fetchCandlesCryptoCompare(provider.baseUrl, pairInfo, interval, limit);
      } else if (provider.type === 'bybit') {
        candles = await fetchCandlesBybit(provider.baseUrl, pairInfo.symbol, interval, limit);
      } else {
        candles = await fetchCandlesBinance(provider.baseUrl, pairInfo.symbol, interval, limit);
      }
      if (candles.length > 0) return candles;
      errors.push(`${provider.name}: returned 0 candles`);
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  throw new Error(`All providers failed for ${pairInfo.symbol} ${interval}: ${errors.join('; ')}`);
}

/**
 * Fetch top trader long/short position ratio from Binance Futures API.
 * Returns the percentage of top trader positions that are long (0.0 to 1.0).
 * Returns null if all providers fail (gate will pass through).
 *
 * @param {string} symbol - e.g. 'SOLUSDT'
 * @param {string} period - e.g. '4h'
 * @returns {Promise<{longRatio: number, shortRatio: number, longShortRatio: number} | null>}
 */
async function fetchSmartMoneyRatio(symbol, period) {
  const errors = [];

  for (const baseUrl of CONFIG.smartMoney.providers) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeout);

    try {
      const url = `${baseUrl}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=${period}&limit=1`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) throw new Error('Empty response');

      const latest = data[0];
      return {
        longRatio: parseFloat(latest.longAccount),     // e.g. 0.3930 = 39.30% long
        shortRatio: parseFloat(latest.shortAccount),    // e.g. 0.6070 = 60.70% short
        longShortRatio: parseFloat(latest.longShortRatio), // e.g. 0.6477
        timestamp: latest.timestamp,
      };
    } catch (err) {
      clearTimeout(timeout);
      errors.push(`${baseUrl}: ${err.message}`);
    }
  }

  console.log(`[SMART MONEY] All providers failed for ${symbol}: ${errors.join('; ')}`);
  return null;
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
  const pairInfo = PAIR_TO_SYMBOL[pair];
  if (!pairInfo) {
    return { allowed: true, reason: 'Unknown pair — passing through', data: {} };
  }

  const data = {};

  try {
    // Fetch daily candles, 4h candles, and smart money ratio in parallel
    // We need more 4h candles now (30) for the 21-period EMA to stabilize
    const [dailyCandles, fourHourCandles, smartMoney] = await Promise.all([
      fetchCandles(pairInfo, CONFIG.trendEma.timeframe, CONFIG.trendEma.candlesNeeded),
      fetchCandles(pairInfo, CONFIG.shortTermEma.timeframe, CONFIG.shortTermEma.candlesNeeded),
      fetchSmartMoneyRatio(pairInfo.symbol, CONFIG.smartMoney.period),
    ]);

    // Calculate daily 50 EMA
    const dailyCloses = dailyCandles.map(c => c.close);
    const currentPrice = dailyCloses[dailyCloses.length - 1];
    const ema50 = calculateEMA(dailyCloses, CONFIG.trendEma.period);

    // Calculate 4h EMA 9 and EMA 21 (short-term trend)
    const fourHourCloses = fourHourCandles.map(c => c.close);
    const ema9 = calculateEMA(fourHourCloses, CONFIG.shortTermEma.fast);
    const ema21 = calculateEMA(fourHourCloses, CONFIG.shortTermEma.slow);

    // Calculate 4h RSI(14) — current value
    const rsi14 = calculateRSI(fourHourCloses, CONFIG.rsi.period);

    // Calculate RSI direction — compare current RSI to N candles ago
    let rsiDirection = 'FLAT';
    const slopeN = CONFIG.rsi.slopeCandles;
    if (fourHourCloses.length > slopeN) {
      const olderCloses = fourHourCloses.slice(0, -slopeN);
      const olderRsi = calculateRSI(olderCloses, CONFIG.rsi.period);
      if (rsi14 !== null && olderRsi !== null) {
        const rsiDelta = rsi14 - olderRsi;
        rsiDirection = rsiDelta > 1.5 ? 'RISING' : rsiDelta < -1.5 ? 'FALLING' : 'FLAT';
        data.rsiPrevious = olderRsi;
        data.rsiDelta = parseFloat(rsiDelta.toFixed(2));
      }
    }

    data.currentPrice = currentPrice;
    data.ema50 = ema50;
    data.ema9_4h = ema9;
    data.ema21_4h = ema21;
    data.shortTermTrend = (ema9 && ema21) ? (ema9 > ema21 ? 'BULLISH' : 'BEARISH') : 'UNKNOWN';
    data.rsi14 = rsi14;
    data.rsiDirection = rsiDirection;
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

    // ── Gate 2: 4H EMA 9/21 short-term trend filter ──────────────────
    // The short-term trend must agree with the trade direction.
    // This prevents shorting during intraday rallies in a daily bearish trend.
    if (ema9 !== null && ema21 !== null) {
      if (direction === 'LONG' && ema9 < ema21) {
        return {
          allowed: false,
          reason: `SHORT-TERM TREND: 4H EMA9 $${ema9.toFixed(2)} < EMA21 $${ema21.toFixed(2)} — short-term bearish, LONG rejected`,
          data,
        };
      }
      if (direction === 'SHORT' && ema9 > ema21) {
        return {
          allowed: false,
          reason: `SHORT-TERM TREND: 4H EMA9 $${ema9.toFixed(2)} > EMA21 $${ema21.toFixed(2)} — short-term bullish, SHORT rejected`,
          data,
        };
      }
    }

    // ── Gate 3: RSI level confirmation ─────────────────────────────────
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

    // ── Gate 4: RSI direction confirmation ─────────────────────────────
    // Block trades when RSI momentum is moving against the trade direction.
    // RISING RSI = bullish momentum building → block shorts
    // FALLING RSI = bearish momentum building → block longs
    if (rsiDirection !== 'FLAT') {
      if (direction === 'SHORT' && rsiDirection === 'RISING') {
        return {
          allowed: false,
          reason: `RSI DIRECTION: RSI rising (${data.rsiPrevious} → ${rsi14}, Δ${data.rsiDelta}) — bullish momentum building, SHORT rejected`,
          data,
        };
      }
      if (direction === 'LONG' && rsiDirection === 'FALLING') {
        return {
          allowed: false,
          reason: `RSI DIRECTION: RSI falling (${data.rsiPrevious} → ${rsi14}, Δ${data.rsiDelta}) — bearish momentum building, LONG rejected`,
          data,
        };
      }
    }

    // ── Gate 5: Smart Money — top trader positioning ────────────────────
    // Block trades when whale positioning strongly disagrees.
    // Fail-open: if Binance Futures API is unreachable, skip this gate.
    if (smartMoney) {
      data.smartMoney = {
        longRatio: smartMoney.longRatio,
        shortRatio: smartMoney.shortRatio,
        longShortRatio: smartMoney.longShortRatio,
        longPct: (smartMoney.longRatio * 100).toFixed(1) + '%',
        shortPct: (smartMoney.shortRatio * 100).toFixed(1) + '%',
      };

      if (direction === 'LONG' && smartMoney.longRatio < CONFIG.smartMoney.longMinRatio) {
        return {
          allowed: false,
          reason: `SMART MONEY: Top traders only ${data.smartMoney.longPct} long (threshold ${CONFIG.smartMoney.longMinRatio * 100}%) — whales heavily short, LONG rejected`,
          data,
        };
      }
      if (direction === 'SHORT' && smartMoney.longRatio > CONFIG.smartMoney.shortMaxRatio) {
        return {
          allowed: false,
          reason: `SMART MONEY: Top traders ${data.smartMoney.longPct} long (threshold ${CONFIG.smartMoney.shortMaxRatio * 100}%) — whales heavily long, SHORT rejected`,
          data,
        };
      }
    } else {
      data.smartMoney = { status: 'unavailable — gate skipped' };
    }

    // All gates passed
    return {
      allowed: true,
      reason: `PASSED: Price $${currentPrice.toFixed(2)} ${data.priceVsEma} EMA50 $${ema50?.toFixed(2) || '?'}, 4H trend ${data.shortTermTrend}, RSI(14) = ${rsi14 || '?'} ${rsiDirection}, Smart Money ${data.smartMoney.longPct || 'N/A'} long`,
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
 * Lightweight re-validation for running bots (v1.7.1).
 * Only checks Gate 2 (4H EMA 9/21) and Gate 4 (RSI direction).
 * Skips daily EMA50 (doesn't change intraday) and RSI level (less actionable).
 *
 * FAIL-CLOSED: If data fetch fails, returns allowed=false.
 * This is the opposite of the initial gate (fail-open) because:
 * - Initial gate: deciding whether to START → fail-open (don't miss opportunities)
 * - Re-validation: bot is already RUNNING → fail-closed (stop if we can't verify)
 *
 * @param {string} pair - e.g. 'ETH', 'SOL', 'XRP'
 * @param {string} direction - 'LONG' or 'SHORT'
 * @returns {{ allowed: boolean, reason: string, data: object }}
 */
async function revalidateSignal(pair, direction) {
  const pairInfo = PAIR_TO_SYMBOL[pair];
  if (!pairInfo) {
    return { allowed: true, reason: 'Unknown pair — passing through', data: {} };
  }

  const data = {};

  try {
    // Single API call — only 4H candles needed for both checks
    const fourHourCandles = await fetchCandles(pairInfo, CONFIG.shortTermEma.timeframe, CONFIG.shortTermEma.candlesNeeded);
    const fourHourCloses = fourHourCandles.map(c => c.close);

    // Gate 2: 4H EMA 9/21 short-term trend
    const ema9 = calculateEMA(fourHourCloses, CONFIG.shortTermEma.fast);
    const ema21 = calculateEMA(fourHourCloses, CONFIG.shortTermEma.slow);

    // Gate 4: RSI direction
    const rsi14 = calculateRSI(fourHourCloses, CONFIG.rsi.period);
    let rsiDirection = 'FLAT';
    const slopeN = CONFIG.rsi.slopeCandles;
    if (fourHourCloses.length > slopeN) {
      const olderCloses = fourHourCloses.slice(0, -slopeN);
      const olderRsi = calculateRSI(olderCloses, CONFIG.rsi.period);
      if (rsi14 !== null && olderRsi !== null) {
        const rsiDelta = rsi14 - olderRsi;
        rsiDirection = rsiDelta > 1.5 ? 'RISING' : rsiDelta < -1.5 ? 'FALLING' : 'FLAT';
        data.rsiPrevious = olderRsi;
        data.rsiDelta = parseFloat(rsiDelta.toFixed(2));
      }
    }

    data.currentPrice = fourHourCloses[fourHourCloses.length - 1];
    data.ema9_4h = ema9;
    data.ema21_4h = ema21;
    data.shortTermTrend = (ema9 && ema21) ? (ema9 > ema21 ? 'BULLISH' : 'BEARISH') : 'UNKNOWN';
    data.rsi14 = rsi14;
    data.rsiDirection = rsiDirection;

    // Check Gate 2: 4H EMA 9/21
    if (ema9 !== null && ema21 !== null) {
      if (direction === 'LONG' && ema9 < ema21) {
        return {
          allowed: false,
          reason: `REVALIDATION — SHORT-TERM TREND: 4H EMA9 $${ema9.toFixed(2)} < EMA21 $${ema21.toFixed(2)} — short-term bearish, LONG no longer valid`,
          data,
        };
      }
      if (direction === 'SHORT' && ema9 > ema21) {
        return {
          allowed: false,
          reason: `REVALIDATION — SHORT-TERM TREND: 4H EMA9 $${ema9.toFixed(2)} > EMA21 $${ema21.toFixed(2)} — short-term bullish, SHORT no longer valid`,
          data,
        };
      }
    }

    // Check Gate 4: RSI direction
    if (rsiDirection !== 'FLAT') {
      if (direction === 'SHORT' && rsiDirection === 'RISING') {
        return {
          allowed: false,
          reason: `REVALIDATION — RSI DIRECTION: RSI rising (${data.rsiPrevious} → ${rsi14}, Δ${data.rsiDelta}) — bullish momentum, SHORT no longer valid`,
          data,
        };
      }
      if (direction === 'LONG' && rsiDirection === 'FALLING') {
        return {
          allowed: false,
          reason: `REVALIDATION — RSI DIRECTION: RSI falling (${data.rsiPrevious} → ${rsi14}, Δ${data.rsiDelta}) — bearish momentum, LONG no longer valid`,
          data,
        };
      }
    }

    // Still valid
    return {
      allowed: true,
      reason: `REVALIDATION PASSED: 4H trend ${data.shortTermTrend}, RSI(14) = ${rsi14 || '?'} ${rsiDirection}`,
      data,
    };

  } catch (err) {
    // FAIL-CLOSED: If we can't verify, stop the bot.
    return {
      allowed: false,
      reason: `REVALIDATION FAIL-CLOSED: Data fetch failed (${err.message}) — stopping bot for safety`,
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
    shortTermEma: `EMA ${CONFIG.shortTermEma.fast}/${CONFIG.shortTermEma.slow} on ${CONFIG.shortTermEma.timeframe} (must agree with trade direction)`,
    rsi: `${CONFIG.rsi.period}-period RSI on ${CONFIG.rsi.timeframe} (LONG > ${CONFIG.rsi.longMinimum}, SHORT < ${CONFIG.rsi.shortMaximum})`,
    rsiDirection: `RSI slope over ${CONFIG.rsi.slopeCandles} candles (RISING blocks SHORT, FALLING blocks LONG)`,
    smartMoney: `Top trader L/S ratio on ${CONFIG.smartMoney.period} (LONG needs >${CONFIG.smartMoney.longMinRatio * 100}% long, SHORT needs <${CONFIG.smartMoney.shortMaxRatio * 100}% long)`,
  };
}

module.exports = { validateSignal, revalidateSignal, getConfig, CONFIG };
