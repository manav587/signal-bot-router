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
const binanceApi = require('./binance-api');
const tradeJournal = require('./trade-journal');

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
    // v3.2.3: Minimum percentage spread between EMA9 and EMA21 before
    // revalidation considers the cross "real". Prevents micro-crosses
    // (e.g. $80.53 vs $80.52 = 0.01%) from flipping profitable positions.
    // Only applies to revalidation — initial entry still uses exact cross.
    minRevalSpreadPct: 0.30, // v3.6.1: 0.30% minimum spread (was 0.15% — too thin, ~$4 on ETH = one wick)
  },

  // RSI momentum confirmation (4h timeframe — same as crossover chart)
  rsi: {
    period: 14,
    timeframe: '4h',
    candlesNeeded: 20,     // Need 20 candles to stabilize a 14-period RSI
    longMinimum: 30,       // Only go LONG if RSI > 30 (widened from 40)
    shortMaximum: 70,      // Only go SHORT if RSI < 70 (widened from 60)
    slopeCandles: 3,       // Compare RSI now vs N candles ago for direction
  },

  // Smart Money gate — Hyperliquid whale positioning (v3.2.0)
  // Tracks specific high-performing whale wallets on Hyperliquid.
  // Public API, no auth needed: POST https://api.hyperliquid.xyz/info
  // Blocks trades when tracked whales are positioned in the OPPOSITE direction.
  // Falls back to Binance top trader L/S ratio if Hyperliquid fails.
  smartMoney: {
    period: '4h',             // Fallback: Binance L/S ratio timeframe
    longMinRatio: 0.35,       // Fallback: Block LONG if top traders < 35% long
    shortMaxRatio: 0.65,      // Fallback: Block SHORT if top traders > 65% long
    providers: [
      'https://fapi.binance.com',    // Binance fallback — may be geo-blocked
      'https://fapi1.binance.com',
    ],
    // Hyperliquid whale tracking (primary data source)
    hyperliquid: {
      apiUrl: 'https://api.hyperliquid.xyz/info',
      // Tracked wallets — high win-rate traders with verified track records
      wallets: [
        {
          address: '0x0ddf9bae2af4b874b96d287a5ad42eb47138a902',
          label: 'pension-usdt.eth',
          // 80%+ win rate, $40M account, 3x leverage, BTC+ETH shorts
          // HyperStats grade: S | Tracker 1
          weight: 1.0,
        },
        {
          address: '0x418aa6bf98a2b2bc93779f810330d88cde488888',
          label: '0x418a',
          // 98.8% win rate, $5.5M account, 25-40x leverage, BTC+ETH only
          // HyperStats grade: S | Tracker 2
          weight: 1.0,
        },
      ],
      // Both wallets use the same Hyperliquid clearinghouseState API — no geo-block.
      mode: 'blocking',
    },
    // Consensus logic (v3.2.2): Two Hyperliquid wallets queried in parallel.
    // - Both trackers oppose signal → BLOCK
    // - One opposes, one agrees → ALLOW (log disagreement)
    // - One has data, other doesn't → defer to the one with data
    // - Neither has data → PASS THROUGH
    consensusMode: 'both-must-oppose',
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

  // v3.6.0: ATR volatility filter (Gate 6 — ADVISORY)
  // Average True Range on 4H timeframe. When ATR is below threshold,
  // the market is range-bound and EMA crossovers are noise.
  // Advisory first — collecting data to determine optimal thresholds.
  atr: {
    period: 14,
    timeframe: '4h',       // Same candles as EMA 9/21 — no extra API call
    // Minimum ATR as % of price. Below this = low volatility, crossovers unreliable.
    // BTC: 1.5% of ~$80k = $1,200 range per 4H candle — reasonable threshold.
    // ALTs (SOL/ETH/XRP) naturally have higher ATR% so this mainly catches BTC chop.
    minAtrPct: 1.0,
    mode: 'advisory',      // 'advisory' (log only) or 'blocking'
  },
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
 * Fetch whale positions from Hyperliquid (v3.2.0).
 * Queries the clearinghouseState endpoint for each tracked wallet.
 * Returns an array of { label, coin, direction, size, leverage, unrealizedPnl, roe }.
 * Free API — no auth needed.
 *
 * @param {string} coin - e.g. 'BTC', 'ETH', 'SOL' — filter positions for this coin
 * @returns {Promise<Array<{label: string, direction: string, size: string, leverage: number, unrealizedPnl: string, roe: string}>>}
 */
async function fetchHyperliquidWhalePositions(coin) {
  const hlConfig = CONFIG.smartMoney.hyperliquid;
  if (!hlConfig || !hlConfig.wallets.length) return [];

  const results = [];

  for (const wallet of hlConfig.wallets) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeout);

    try {
      const res = await fetch(hlConfig.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'clearinghouseState',
          user: wallet.address,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`Hyperliquid API ${res.status}`);

      const data = await res.json();
      const positions = data.assetPositions || [];

      // Find position matching our coin
      for (const pos of positions) {
        const p = pos.position;
        if (p.coin === coin) {
          const size = parseFloat(p.szi);
          results.push({
            label: wallet.label,
            address: wallet.address,
            weight: wallet.weight,
            coin: p.coin,
            direction: size < 0 ? 'SHORT' : 'LONG',
            size: p.szi,
            leverage: p.leverage?.value || 0,
            entryPx: p.entryPx,
            unrealizedPnl: p.unrealizedPnl,
            roe: p.returnOnEquity,
          });
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      console.log(`[WHALE GATE] Failed to fetch ${wallet.label}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Fetch Binance copy trader directional bias (v3.2.1).
 * Polls closed position history and derives directional bias per coin.
 * Returns { direction: 'SHORT'|'LONG'|null, confidence: 0.0-1.0, trades: number }
 *
 * @param {string} coin - e.g. 'BTC', 'ETH', 'SOL'
 * @returns {Promise<{label: string, direction: string|null, confidence: number, shortCount: number, longCount: number, trades: number}>}
 */
async function fetchBinanceCopyTraderBias(coin) {
  const ctConfig = CONFIG.smartMoney.binanceCopyTrader;
  if (!ctConfig) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeout + 2000); // extra time for Binance

  try {
    const res = await fetch(ctConfig.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portfolioId: ctConfig.portfolioId,
        pageNumber: 1,
        pageSize: 50, // Fetch enough to get lookback trades per coin
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Binance copy trade API ${res.status}`);

    const data = await res.json();
    if (data.code !== '000000' || !data.data?.list) throw new Error('Bad response');

    // Filter trades for this coin
    const symbol = `${coin}USDT`;
    const coinTrades = data.data.list
      .filter(t => t.symbol === symbol && t.status === 'All Closed')
      .slice(0, ctConfig.lookback);

    if (coinTrades.length === 0) {
      return { label: ctConfig.label, direction: null, confidence: 0, shortCount: 0, longCount: 0, trades: 0 };
    }

    const shortCount = coinTrades.filter(t => t.side === 'Short').length;
    const longCount = coinTrades.filter(t => t.side === 'Long').length;
    const total = coinTrades.length;
    const dominantDirection = shortCount >= longCount ? 'SHORT' : 'LONG';
    const confidence = Math.max(shortCount, longCount) / total;

    return {
      label: ctConfig.label,
      direction: confidence >= ctConfig.biasThreshold ? dominantDirection : null,
      confidence,
      shortCount,
      longCount,
      trades: total,
    };
  } catch (err) {
    clearTimeout(timeout);
    console.log(`[WHALE GATE] Failed to fetch ${ctConfig.label} bias: ${err.message}`);
    return null;
  }
}

/**
 * Fetch top trader long/short position ratio from Binance Futures API (fallback).
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

  console.log(`[SMART MONEY] All Binance providers failed for ${symbol}: ${errors.join('; ')}`);
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
 * Calculate ATR (Average True Range) for a series of candles (v3.6.0).
 * True Range = max(high-low, |high-prevClose|, |low-prevClose|)
 * ATR = EMA of True Range over N periods.
 *
 * @param {Array<{high, low, close}>} candles - OHLC candle array (oldest first)
 * @param {number} period - ATR period (default 14)
 * @returns {number|null} - current ATR value, or null if not enough data
 */
function calculateATR(candles, period) {
  if (candles.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  // Use EMA for ATR smoothing
  const ema = new EMA(period);
  for (const tr of trueRanges) {
    ema.update(tr);
  }
  return ema.isStable ? parseFloat(ema.getResult().toFixed(6)) : null;
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
    // Fetch daily candles, 4h candles, Binance L/S ratio, and Hyperliquid whale positions in parallel
    // We need more 4h candles now (30) for the 21-period EMA to stabilize
    const [dailyCandles, fourHourCandles, smartMoney] = await Promise.all([
      fetchCandles(pairInfo, CONFIG.trendEma.timeframe, CONFIG.trendEma.candlesNeeded),
      fetchCandles(pairInfo, CONFIG.shortTermEma.timeframe, CONFIG.shortTermEma.candlesNeeded),
      fetchSmartMoneyRatio(pairInfo.symbol, CONFIG.smartMoney.period),
    ]);
    // Note: Hyperliquid whale positions are fetched in Gate 5 block below
    // (needs 'pair' not 'symbol', and is a separate concern from candle data)

    // Calculate daily 50 EMA
    const dailyCloses = dailyCandles.map(c => c.close);
    const candleClose = dailyCloses[dailyCloses.length - 1];
    const ema50 = calculateEMA(dailyCloses, CONFIG.trendEma.period);

    // v3.5.0: Use LIVE spot price for gate decisions, not stale candle close.
    // Daily candle close can be up to 24 hours old — useless for real-time gating.
    // Falls back to candle close if spot fetch fails.
    const spotPrice = await binanceApi.getSpotPrice(pairInfo.symbol).catch(() => null);
    const currentPrice = spotPrice || candleClose;

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

    // ── Gate 1: Daily 50 EMA trend filter (ADVISORY — demoted v3.6.3) ──
    // Price vs daily EMA50: logged but not blocking.
    // Was blocking from v3.4.0–v3.6.2, but in range-bound markets it creates
    // dead zones where BOTH directions are gated (Gate 1 blocks longs while
    // Gate 2 blocks shorts). BTC sat completely frozen for days.
    // Demoted to advisory — Gate 2 (4H EMA) + Gate 3 (RSI) + Gate 5 (whales)
    // still provide directional filtering. Gate 1 data is logged for review.
    if (ema50 !== null) {
      const g1WouldBlock =
        (direction === 'LONG' && currentPrice < ema50) ||
        (direction === 'SHORT' && currentPrice > ema50);
      data.gate1 = {
        wouldBlock: g1WouldBlock,
        mode: 'advisory',
        detail: g1WouldBlock
          ? `Price $${currentPrice.toFixed(2)} vs EMA50 $${ema50.toFixed(2)} — would have blocked ${direction}`
          : `Price $${currentPrice.toFixed(2)} vs EMA50 $${ema50.toFixed(2)} — aligned with ${direction}`,
      };
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

    // ── Gate 4: RSI direction confirmation (ADVISORY ONLY) ─────────────
    // Logged but not blocking. Collecting data during prove-it period.
    if (rsiDirection !== 'FLAT') {
      const g4WouldBlock =
        (direction === 'SHORT' && rsiDirection === 'RISING') ||
        (direction === 'LONG' && rsiDirection === 'FALLING');
      data.gate4Advisory = {
        wouldBlock: g4WouldBlock,
        mode: 'advisory',
        detail: g4WouldBlock
          ? `RSI ${rsiDirection} (${data.rsiPrevious} → ${rsi14}, Δ${data.rsiDelta}) — would have blocked ${direction}`
          : `RSI ${rsiDirection} — aligned with ${direction}`,
      };
    }

    // ── Gate 5: Two-Tracker Consensus Whale Gate (v3.2.2) ──────────────
    // Tracker 1: pension-usdt.eth (Hyperliquid) — 3x lev, $40M, S grade
    // Tracker 2: 0x418a (Hyperliquid) — 25-40x lev, $5.5M, S grade, 98.8% WR
    // Both use same Hyperliquid API — no geo-block from Render.
    const hlConfig = CONFIG.smartMoney.hyperliquid;
    const consensusMode = CONFIG.smartMoney.consensusMode || 'both-must-oppose';

    // Single API call fetches positions for ALL tracked wallets
    const whalePositions = await fetchHyperliquidWhalePositions(pair);

    // v3.6.0: Record whale activity for staleness monitoring
    for (const wp of whalePositions) {
      tradeJournal.recordWhaleActivity(wp.address, wp.label, wp.coin, wp.direction);
    }

    // Split positions by wallet into tracker 1 and tracker 2
    const wallet1 = hlConfig.wallets[0]; // pension-usdt.eth
    const wallet2 = hlConfig.wallets[1]; // 0x418a

    const w1Positions = whalePositions.filter(w => w.address === wallet1.address);
    const w2Positions = whalePositions.filter(w => w.address === wallet2.address);

    // ── Tracker 1: pension-usdt.eth stance ──
    let tracker1 = { label: wallet1.label, stance: 'no-data', detail: null };
    if (w1Positions.length > 0) {
      const opposing = w1Positions.filter(w => w.direction !== direction);
      tracker1.stance = opposing.length > 0 ? 'opposing' : 'aligned';
      tracker1.detail = w1Positions.map(w => ({
        label: w.label, direction: w.direction, size: w.size,
        leverage: w.leverage, entryPx: w.entryPx,
        unrealizedPnl: w.unrealizedPnl, roe: w.roe,
      }));
    }

    // ── Tracker 2: 0x418a stance ──
    let tracker2 = { label: wallet2.label, stance: 'no-data', detail: null };
    if (w2Positions.length > 0) {
      const opposing = w2Positions.filter(w => w.direction !== direction);
      tracker2.stance = opposing.length > 0 ? 'opposing' : 'aligned';
      tracker2.detail = w2Positions.map(w => ({
        label: w.label, direction: w.direction, size: w.size,
        leverage: w.leverage, entryPx: w.entryPx,
        unrealizedPnl: w.unrealizedPnl, roe: w.roe,
      }));
    }

    // ── Consensus logic ──
    data.whaleGate = { version: '3.2.2', consensusMode, tracker1, tracker2 };

    const t1Opposes = tracker1.stance === 'opposing';
    const t2Opposes = tracker2.stance === 'opposing';
    const t1HasData = tracker1.stance !== 'no-data';
    const t2HasData = tracker2.stance !== 'no-data';

    let gatePassed = true;
    let gateReason = '';

    if (consensusMode === 'both-must-oppose') {
      if (t1Opposes && t2Opposes) {
        gatePassed = false;
        const allOpposing = whalePositions.filter(w => w.direction !== direction);
        const detail = allOpposing.map(w =>
          `${w.label} ${w.direction} ${w.coin} (${w.size} @ ${w.entryPx}, ${w.leverage}x, PnL: $${parseFloat(w.unrealizedPnl).toFixed(0)})`
        ).join('; ');
        gateReason = `CONSENSUS BLOCK: Both trackers oppose ${direction} — ${detail}`;
      } else if (t1Opposes && !t2HasData) {
        gatePassed = false;
        const detail = w1Positions.filter(w => w.direction !== direction).map(w =>
          `${w.label} ${w.direction} ${w.coin} (${w.size} @ ${w.entryPx}, ${w.leverage}x)`
        ).join('; ');
        gateReason = `WHALE GATE (solo): ${detail} opposes ${direction} — ${tracker2.label} has no position, deferring to ${tracker1.label}`;
      } else if (!t1HasData && t2Opposes) {
        gatePassed = false;
        const detail = w2Positions.filter(w => w.direction !== direction).map(w =>
          `${w.label} ${w.direction} ${w.coin} (${w.size} @ ${w.entryPx}, ${w.leverage}x)`
        ).join('; ');
        gateReason = `WHALE GATE (solo): ${detail} opposes ${direction} — ${tracker1.label} has no position, deferring to ${tracker2.label}`;
      } else if (t1Opposes !== t2Opposes && t1HasData && t2HasData) {
        const opposer = t1Opposes ? tracker1.label : tracker2.label;
        const supporter = t1Opposes ? tracker2.label : tracker1.label;
        gateReason = `SPLIT SIGNAL: ${opposer} opposes but ${supporter} aligns — allowing ${direction} (disagreement logged)`;
        data.whaleGate.disagreement = true;
      } else {
        gateReason = t1HasData || t2HasData
          ? `CONSENSUS PASS: ${[t1HasData ? `${tracker1.label} ${tracker1.stance}` : null, t2HasData ? `${tracker2.label} ${tracker2.stance}` : null].filter(Boolean).join(', ')}`
          : 'CONSENSUS PASS: Neither tracker has position data for this coin';
      }
    }

    data.whaleGate.result = gatePassed ? 'PASS' : 'BLOCK';
    data.whaleGate.reason = gateReason;

    if (!gatePassed) {
      return { allowed: false, reason: gateReason, data };
    }

    // Binance L/S ratio — advisory fallback (logged, not blocking)
    if (smartMoney) {
      const wouldBlock =
        (direction === 'LONG' && smartMoney.longRatio < CONFIG.smartMoney.longMinRatio) ||
        (direction === 'SHORT' && smartMoney.longRatio > CONFIG.smartMoney.shortMaxRatio);

      data.smartMoney = {
        longRatio: smartMoney.longRatio,
        shortRatio: smartMoney.shortRatio,
        longShortRatio: smartMoney.longShortRatio,
        longPct: (smartMoney.longRatio * 100).toFixed(1) + '%',
        shortPct: (smartMoney.shortRatio * 100).toFixed(1) + '%',
        wouldBlock,
        mode: 'advisory',
      };
    } else {
      data.smartMoney = { status: 'unavailable', mode: 'advisory' };
    }

    // ── Gate 6: ATR volatility filter (v3.6.0 — ADVISORY) ──────────────
    // Low ATR = tight range = EMA crossovers are noise.
    // Uses the 4H candles already fetched (no extra API call).
    const atr = calculateATR(fourHourCandles, CONFIG.atr.period);
    if (atr !== null && currentPrice > 0) {
      const atrPct = (atr / currentPrice) * 100;
      const wouldBlock = atrPct < CONFIG.atr.minAtrPct;
      data.gate6Volatility = {
        atr: parseFloat(atr.toFixed(4)),
        atrPct: parseFloat(atrPct.toFixed(3)),
        minAtrPct: CONFIG.atr.minAtrPct,
        wouldBlock,
        mode: CONFIG.atr.mode,
        detail: wouldBlock
          ? `ATR ${atrPct.toFixed(2)}% < ${CONFIG.atr.minAtrPct}% — low volatility, crossovers may be noise`
          : `ATR ${atrPct.toFixed(2)}% ≥ ${CONFIG.atr.minAtrPct}% — sufficient volatility`,
      };
      // Block if mode is 'blocking' (currently advisory — collecting data)
      if (wouldBlock && CONFIG.atr.mode === 'blocking') {
        return {
          allowed: false,
          reason: `VOLATILITY FILTER: 4H ATR ${atrPct.toFixed(2)}% < ${CONFIG.atr.minAtrPct}% — market too quiet for reliable crossover signals`,
          data,
        };
      }
    }

    // All gates passed
    const consensusInfo = data.whaleGate.reason || 'no whale data';
    return {
      allowed: true,
      reason: `PASSED: Price $${currentPrice.toFixed(2)} ${data.priceVsEma} EMA50 $${ema50?.toFixed(2) || '?'}, 4H trend ${data.shortTermTrend}, RSI(14) = ${rsi14 || '?'} ${rsiDirection}, ${consensusInfo}`,
      data,
    };

  } catch (err) {
    // v3.5.0: FAIL-CLOSED — if we can't validate, don't trade.
    // A Binance API outage is not a reason to skip all safety checks.
    // The signal will either arrive again (TradingView resends) or
    // self-heal will pick up the pair when data returns.
    return {
      allowed: false,
      reason: `GATE ERROR (blocked — fail-closed): ${err.message}`,
      data,
    };
  }
}

/**
 * Re-validation for running bots (v3.5.0).
 * Checks Gate 1 (daily EMA50), Gate 2 (4H EMA 9/21), Gate 3 (RSI level).
 * Uses live spot price from Binance, not stale candle closes.
 *
 * FAIL-CLOSED: If data fetch fails, returns allowed=false.
 * Bot is already RUNNING → fail-closed (stop if we can't verify safety).
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
    // v3.5.0: Fetch daily candles (for Gate 1) and 4H candles (for Gate 2+3) in parallel
    // Plus live spot price so we're not using stale candle closes
    const [dailyCandles, fourHourCandles, spotPrice] = await Promise.all([
      fetchCandles(pairInfo, CONFIG.trendEma.timeframe, CONFIG.trendEma.candlesNeeded),
      fetchCandles(pairInfo, CONFIG.shortTermEma.timeframe, CONFIG.shortTermEma.candlesNeeded),
      binanceApi.getSpotPrice(pairInfo.symbol).catch(() => null),
    ]);

    const fourHourCloses = fourHourCandles.map(c => c.close);
    const dailyCloses = dailyCandles.map(c => c.close);

    // v3.5.0: Use live spot price, fall back to 4H candle close
    const candlePrice = fourHourCloses[fourHourCloses.length - 1];
    const currentPrice = spotPrice || candlePrice;

    // Gate 1: Daily EMA50 (v3.5.0 — now checked during revalidation too)
    const ema50 = calculateEMA(dailyCloses, CONFIG.trendEma.period);

    // Gate 2: 4H EMA 9/21 short-term trend
    const ema9 = calculateEMA(fourHourCloses, CONFIG.shortTermEma.fast);
    const ema21 = calculateEMA(fourHourCloses, CONFIG.shortTermEma.slow);

    // Gate 3+4: RSI
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

    data.currentPrice = currentPrice;
    data.spotPrice = spotPrice;
    data.ema50 = ema50;
    data.ema9_4h = ema9;
    data.ema21_4h = ema21;
    data.shortTermTrend = (ema9 && ema21) ? (ema9 > ema21 ? 'BULLISH' : 'BEARISH') : 'UNKNOWN';
    data.rsi14 = rsi14;
    data.rsiDirection = rsiDirection;
    data.priceVsEma = ema50 ? (currentPrice > ema50 ? 'ABOVE' : 'BELOW') : 'UNKNOWN';

    // ── Gate 1 (reval): Daily EMA50 — ADVISORY v3.6.3 ──
    // Demoted from blocking. In range-bound markets, price oscillates around
    // EMA50 constantly — closing positions every time price dips below it
    // causes premature exits during normal volatility. The 4H EMA cross and
    // RSI still drive reval exits. Gate 1 data is logged for review.
    if (ema50 !== null) {
      const g1WouldFail =
        (direction === 'LONG' && currentPrice < ema50) ||
        (direction === 'SHORT' && currentPrice > ema50);
      data.gate1Reval = {
        wouldFail: g1WouldFail,
        mode: 'advisory',
        detail: `Price $${currentPrice.toFixed(2)} vs EMA50 $${ema50.toFixed(2)} — ${g1WouldFail ? 'WRONG SIDE (advisory)' : 'aligned'}`,
      };
    }

    // ── Gate 2 (reval): 4H EMA 9/21 ──
    // v3.2.3: Require minimum spread before flipping — prevents micro-crosses
    if (ema9 !== null && ema21 !== null) {
      const emaSpreadPct = Math.abs(ema9 - ema21) / ema21 * 100;
      const minSpread = CONFIG.shortTermEma.minRevalSpreadPct || 0;
      data.emaSpreadPct = parseFloat(emaSpreadPct.toFixed(4));
      data.minRevalSpreadPct = minSpread;

      if (direction === 'LONG' && ema9 < ema21 && emaSpreadPct >= minSpread) {
        return {
          allowed: false,
          reason: `REVALIDATION — SHORT-TERM TREND: 4H EMA9 $${ema9.toFixed(2)} < EMA21 $${ema21.toFixed(2)} (spread ${emaSpreadPct.toFixed(3)}% ≥ ${minSpread}%) — short-term bearish, LONG no longer valid`,
          data,
        };
      }
      if (direction === 'SHORT' && ema9 > ema21 && emaSpreadPct >= minSpread) {
        return {
          allowed: false,
          reason: `REVALIDATION — SHORT-TERM TREND: 4H EMA9 $${ema9.toFixed(2)} > EMA21 $${ema21.toFixed(2)} (spread ${emaSpreadPct.toFixed(3)}% ≥ ${minSpread}%) — short-term bullish, SHORT no longer valid`,
          data,
        };
      }
      if ((direction === 'LONG' && ema9 < ema21) || (direction === 'SHORT' && ema9 > ema21)) {
        data.microCrossIgnored = true;
        data.microCrossDetail = `EMA cross detected but spread ${emaSpreadPct.toFixed(3)}% < ${minSpread}% threshold — treating as noise`;
      }
    }

    // ── Gate 3 (reval): RSI level — v3.5.0 ──
    // If RSI has moved to extreme territory, close the position.
    // Same thresholds as entry: LONG requires RSI > 30, SHORT requires RSI < 70.
    if (rsi14 !== null) {
      const g3Failed =
        (direction === 'LONG' && rsi14 < CONFIG.rsi.longMinimum) ||
        (direction === 'SHORT' && rsi14 > CONFIG.rsi.shortMaximum);
      data.gate3Reval = {
        failed: g3Failed,
        detail: `RSI(14) = ${rsi14.toFixed(1)} — ${g3Failed ? 'EXTREME' : 'in range'}`,
      };
      if (g3Failed) {
        return {
          allowed: false,
          reason: `REVALIDATION — RSI EXTREME: RSI(14) = ${rsi14.toFixed(1)} — ${direction === 'LONG' ? `below ${CONFIG.rsi.longMinimum} (oversold)` : `above ${CONFIG.rsi.shortMaximum} (overbought)`}`,
          data,
        };
      }
    }

    // Gate 4 (RSI direction) remains advisory
    if (rsiDirection !== 'FLAT') {
      const g4WouldBlock =
        (direction === 'SHORT' && rsiDirection === 'RISING') ||
        (direction === 'LONG' && rsiDirection === 'FALLING');
      data.gate4Advisory = {
        wouldBlock: g4WouldBlock,
        mode: 'advisory',
        detail: g4WouldBlock
          ? `RSI ${rsiDirection} (${data.rsiPrevious} → ${rsi14}, Δ${data.rsiDelta}) — would have blocked ${direction}`
          : `RSI ${rsiDirection} — aligned with ${direction}`,
      };
    }

    // All reval gates passed
    return {
      allowed: true,
      reason: `REVALIDATION PASSED: Price $${currentPrice.toFixed(2)} ${data.priceVsEma} EMA50, 4H trend ${data.shortTermTrend}, RSI(14) = ${rsi14 || '?'} ${rsiDirection}`,
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
    trendEma: `${CONFIG.trendEma.period}-period EMA on ${CONFIG.trendEma.timeframe} (ADVISORY — demoted v3.6.3, was blocking v3.4.0–v3.6.2)`,
    shortTermEma: `EMA ${CONFIG.shortTermEma.fast}/${CONFIG.shortTermEma.slow} on ${CONFIG.shortTermEma.timeframe} (BLOCKING — must agree with trade direction)`,
    rsi: `${CONFIG.rsi.period}-period RSI on ${CONFIG.rsi.timeframe} (BLOCKING — LONG > ${CONFIG.rsi.longMinimum}, SHORT < ${CONFIG.rsi.shortMaximum})`,
    rsiDirection: `RSI slope over ${CONFIG.rsi.slopeCandles} candles (ADVISORY — logged only)`,
    smartMoney: `Binance top trader L/S ratio on ${CONFIG.smartMoney.period} (ADVISORY — fallback)`,
    whaleGate: {
      version: '3.2.2',
      consensusMode: CONFIG.smartMoney.consensusMode,
      tracker1: `Hyperliquid: ${CONFIG.smartMoney.hyperliquid.wallets[0]?.label} (live positions)`,
      tracker2: `Hyperliquid: ${CONFIG.smartMoney.hyperliquid.wallets[1]?.label} (live positions)`,
      logic: 'BLOCK only when both trackers oppose signal direction',
    },
    volatility: `ATR(${CONFIG.atr.period}) on ${CONFIG.atr.timeframe} — min ${CONFIG.atr.minAtrPct}% (${CONFIG.atr.mode.toUpperCase()})`,
  };
}

module.exports = { validateSignal, revalidateSignal, getConfig, CONFIG };
