/**
 * Binance Futures Direct API via CCXT
 * Replaces gainium-api.js for V5 architecture.
 *
 * Direct Binance USDT-M Futures trading (no bot management platform).
 * Used by Signal Bot Router relay to open/close positions, verify flats.
 *
 * Env vars required:
 *   BINANCE_API_KEY    — from Binance API Management
 *   BINANCE_API_SECRET — the HMAC secret paired with the key
 *
 * Trading Parameters (hardcoded):
 *   Position size: $2,000 notional
 *   Leverage: 10x isolated
 *   Stop loss: -0.5% from entry price
 *   Pairs: SOLUSDT, ETHUSDT, XRPUSDT, BTCUSDT
 */

const ccxt = require('ccxt');

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

// ── Trading Constants ─────────────────────────────────────────────────────

const POSITION_SIZE_USDT = 1500;      // $1,500 notional per position
const LEVERAGE = 10;                  // 10x isolated
const SL_PERCENT = -1.0;              // -1.0% from entry

// UUID → Pair + Direction Mapping (must match server.js BOT_MAP)
const BOT_MAP = {
  '61a66c9f-7463-46db-a72f-2ef39565bc20': { pair: 'SOLUSDT', direction: 'LONG', mongoId: '69ce1dc4228af151def7f93e', name: 'SOL Long v2' },
  '3af77f4f-73a7-45c1-a0fd-b7c3ce9f16ee': { pair: 'SOLUSDT', direction: 'SHORT', mongoId: '69ce1dc6228af151def7f97b', name: 'SOL Short v2' },
  '4d6f6265-4c9a-42e7-bf85-8956a1c03f6c': { pair: 'ETHUSDT', direction: 'LONG', mongoId: '69ce1dc8228af151def7f9a0', name: 'ETH Long v2' },
  '69c91263-68c9-4f88-a543-7c319b5fde8b': { pair: 'ETHUSDT', direction: 'SHORT', mongoId: '69ce1dca228af151def7fa03', name: 'ETH Short v2' },
  'eb74f76c-c6ec-48c2-a74d-d9fd27c2fab5': { pair: 'XRPUSDT', direction: 'LONG', mongoId: '69ce1dcc228af151def7fa3c', name: 'XRP Long v2' },
  '2751574b-cc46-4f62-bd01-cb404c21f8d7': { pair: 'XRPUSDT', direction: 'SHORT', mongoId: '69ce1dcd228af151def7fab8', name: 'XRP Short v2' },
  '21c9985a-db38-4409-af79-26f389d32d0a': { pair: 'BTCUSDT', direction: 'LONG', mongoId: '69ce1dcf228af151def7faf7', name: 'BTC Long v2' },
  'd0ea54dc-7218-4662-b2bf-0c66f4be9e44': { pair: 'BTCUSDT', direction: 'SHORT', mongoId: '69ce1dd1228af151def7fb2e', name: 'BTC Short v2' },
};

// Reverse mappings
const MONGO_ID_MAP = {};
const PAIR_MAP = {};
for (const [uuid, info] of Object.entries(BOT_MAP)) {
  MONGO_ID_MAP[info.mongoId] = info;
  if (!PAIR_MAP[info.pair]) PAIR_MAP[info.pair] = [];
  PAIR_MAP[info.pair].push(info);
}

// Supported pairs (for getExchangePositionMap)
const SUPPORTED_PAIRS = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT', 'BTCUSDT'];

// ── Logging (uses same IST format as server.js) ──────────────────────────

function istTimestamp() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function log(msg) {
  console.log(`[${istTimestamp()}] [exchange-api] ${msg}`);
}

// ── Exchange Initialization ──────────────────────────────────────────────

let exchange = null;
let marketsLoaded = false;

function getExchange() {
  if (!exchange) {
    exchange = new ccxt.binanceusdm({
      apiKey: API_KEY,
      secret: API_SECRET,
      enableRateLimit: true,
    });
  }
  return exchange;
}

async function ensureMarkets() {
  const exch = getExchange();
  if (!marketsLoaded) {
    await exch.loadMarkets();
    marketsLoaded = true;
    log('Markets loaded');
  }
  return exch;
}

// ── Mapping Utilities ────────────────────────────────────────────────────

/**
 * Resolve input (UUID, mongoId, or pair string) to bot config.
 * @param {string} input — UUID, mongoId, or pair name
 * @returns {object|null} — { pair, direction, mongoId, name } or null
 */
function resolveBotConfig(input) {
  // Try UUID first
  if (BOT_MAP[input]) return BOT_MAP[input];
  // Try mongoId
  if (MONGO_ID_MAP[input]) return MONGO_ID_MAP[input];
  // Try pair — return the LONG variant (arbitrary choice for metadata)
  if (PAIR_MAP[input] && PAIR_MAP[input].length > 0) {
    return PAIR_MAP[input][0]; // return first config for this pair
  }
  return null;
}

/**
 * Extract pair from any input.
 * @param {string} input — UUID, mongoId, or pair
 * @returns {string|null} — pair name or null
 */
function resolvePair(input) {
  const config = resolveBotConfig(input);
  if (config) return config.pair;
  // Check if input is already a pair
  if (SUPPORTED_PAIRS.includes(input)) return input;
  return null;
}

/**
 * Extract direction from input.
 * If input is just a pair (no UUID/mongoId), return null (unknown direction).
 * @param {string} input — UUID, mongoId, or pair
 * @returns {string|null} — 'LONG'|'SHORT' or null
 */
function resolveDirection(input) {
  const config = resolveBotConfig(input);
  if (config) return config.direction;
  return null;
}

// ── Verification Utilities ───────────────────────────────────────────────

/**
 * Check if an open position exists for the pair.
 * @param {string} pair — e.g. 'SOLUSDT'
 * @returns {object|null} — position details or null if no position
 */
async function getPositionForPair(pair) {
  try {
    const exch = getExchange();
    const positions = await exch.fetchPositions([pair]);
    if (!positions || positions.length === 0) return null;

    // CCXT returns LONG and SHORT as separate position objects
    // Find the one with non-zero size
    for (const pos of positions) {
      if (pos.contracts && pos.contracts !== 0) {
        return pos;
      }
    }
    return null;
  } catch (err) {
    log(`getPositionForPair error for ${pair}: ${err.message}`);
    return null;
  }
}

// ── API Functions (matching gainium-api.js interface) ─────────────────────

/**
 * Check if API credentials are configured.
 */
function isConfigured() {
  return API_KEY.length > 0 && API_SECRET.length > 0;
}

/**
 * Get bot deal status (UUID → position check).
 * Returns { active: 1|0, all: 1|0 } to match gainium-api interface.
 * @param {string} pairOrUuid — UUID, mongoId, or pair name
 * @returns {{ active: number, all: number }}
 */
async function getBotDeals(pairOrUuid) {
  const pair = resolvePair(pairOrUuid);
  if (!pair) {
    log(`getBotDeals: could not resolve pair from ${pairOrUuid}`);
    return { active: 0, all: 0 };
  }

  try {
    const pos = await getPositionForPair(pair);
    if (pos && pos.contracts && pos.contracts !== 0) {
      return { active: 1, all: 1 };
    }
    return { active: 0, all: 0 };
  } catch (err) {
    log(`getBotDeals error for ${pair}: ${err.message}`);
    return { active: 0, all: 0 };
  }
}

/**
 * Get status of ALL bots (all pairs).
 * Returns Map<uuid, { status, deals, name }> matching gainium format.
 */
async function getAllBotStatuses() {
  const statusMap = new Map();

  for (const [uuid, config] of Object.entries(BOT_MAP)) {
    const pair = config.pair;
    try {
      const pos = await getPositionForPair(pair);
      const hasPosition = pos && pos.contracts && pos.contracts !== 0;

      statusMap.set(uuid, {
        status: hasPosition ? 'open' : 'closed',
        deals: hasPosition ? { active: 1, all: 1 } : { active: 0, all: 0 },
        name: config.name,
      });
    } catch (err) {
      log(`getAllBotStatuses error for ${config.name}: ${err.message}`);
      statusMap.set(uuid, {
        status: 'error',
        deals: { active: 0, all: 0 },
        name: config.name,
      });
    }
  }

  log(`getAllBotStatuses: fetched ${statusMap.size} bot(s)`);
  return statusMap;
}

/**
 * List open deals for a specific bot/pair.
 * Returns array of deal objects (one per open position).
 * @param {string} mongoIdOrPair — mongoId or pair name
 * @returns {Array} — deal objects
 */
async function listOpenDeals(mongoIdOrPair) {
  const pair = resolvePair(mongoIdOrPair);
  const config = resolveBotConfig(mongoIdOrPair);

  if (!pair) {
    log(`listOpenDeals: could not resolve pair from ${mongoIdOrPair}`);
    return [];
  }

  try {
    const pos = await getPositionForPair(pair);
    if (!pos || !pos.contracts || pos.contracts === 0) {
      return [];
    }

    const side = pos.side === 'long' ? 'LONG' : 'SHORT';
    const deal = {
      _id: pair,
      pair: pair,
      symbol: pair,
      status: 'active',
      side,
      size: Math.abs(pos.contracts),
      entryPrice: pos.average || 0,
      markPrice: pos.markPrice || 0,
      pnl: pos.unrealizedPnl || 0,
    };

    log(`listOpenDeals: found 1 open deal for ${pair} (${side})`);
    return [deal];
  } catch (err) {
    log(`listOpenDeals error for ${pair}: ${err.message}`);
    return [];
  }
}

/**
 * List ALL open deals across all pairs.
 */
async function listAllOpenDeals() {
  const allDeals = [];

  for (const pair of SUPPORTED_PAIRS) {
    const deals = await listOpenDeals(pair);
    allDeals.push(...deals);
  }

  log(`listAllOpenDeals: found ${allDeals.length} total open deal(s)`);
  return allDeals;
}

/**
 * Force close all positions for a pair.
 * Closes position and cancels open SL orders.
 * @param {string} uuidOrPair — UUID or pair name
 * @returns {boolean} — true on success
 */
async function forceCloseDeals(uuidOrPair) {
  const pair = resolvePair(uuidOrPair);
  if (!pair) {
    log(`forceCloseDeals: could not resolve pair from ${uuidOrPair}`);
    return false;
  }

  try {
    const exch = getExchange();

    // Get current position to determine close side
    const pos = await getPositionForPair(pair);
    if (!pos || !pos.contracts || pos.contracts === 0) {
      log(`forceCloseDeals: no position to close for ${pair}`);
      return true; // Not an error — already flat
    }

    // Close market order
    const closeQty = Math.abs(pos.contracts);
    const closeSide = pos.side === 'long' ? 'sell' : 'buy';

    log(`forceCloseDeals: closing ${pair} ${closeSide} ${closeQty} contracts`);
    await exch.createMarketOrder(pair, closeSide, closeQty);

    // Cancel any open orders for this pair
    try {
      const openOrders = await exch.fetchOpenOrders(pair);
      for (const order of openOrders) {
        log(`forceCloseDeals: canceling order ${order.id} for ${pair}`);
        await exch.cancelOrder(order.id, pair);
      }
    } catch (cancelErr) {
      log(`forceCloseDeals: error canceling orders for ${pair}: ${cancelErr.message}`);
      // Non-fatal — position is already closed
    }

    log(`forceCloseDeals: ✅ Closed ${pair}`);
    return true;
  } catch (err) {
    log(`forceCloseDeals error for ${uuidOrPair}: ${err.message}`);
    return false;
  }
}

/**
 * Close deals via API (matching gainium-api interface).
 * @param {string} mongoIdOrPair — mongoId or pair
 * @param {string} botName — for logging
 * @param {string} closeType — 'closeByMarket' or 'cancel'
 * @returns {{ closed: number, failed: number }}
 */
async function closeDealsViaApi(mongoIdOrPair, botName, closeType = 'closeByMarket') {
  const pair = resolvePair(mongoIdOrPair);
  if (!pair) {
    log(`closeDealsViaApi [${botName}]: could not resolve pair`);
    return { closed: 0, failed: 0 };
  }

  try {
    const deals = await listOpenDeals(pair);
    if (deals.length === 0) {
      log(`closeDealsViaApi [${botName}] (${closeType}): no open deals for ${pair}`);
      return { closed: 0, failed: 0 };
    }

    const closed = await forceCloseDeals(pair) ? deals.length : 0;
    const failed = deals.length - closed;

    log(`closeDealsViaApi [${botName}] (${closeType}): ${closed} closed, ${failed} failed`);
    return { closed, failed };
  } catch (err) {
    log(`closeDealsViaApi [${botName}] error: ${err.message}`);
    return { closed: 0, failed: 0 };
  }
}

/**
 * Verify and force close (matching gainium-api interface).
 * Returns { flat: boolean, forceClosed: number, error: string|null }.
 * @param {string} uuid — bot UUID
 * @param {string} mongoId — MongoDB ObjectId (for compatibility)
 * @param {string} botName — for logging
 */
async function verifyAndForceClose(uuid, mongoId, botName) {
  const pair = resolvePair(uuid);
  if (!pair) {
    return { flat: false, forceClosed: 0, error: 'Could not resolve pair from UUID' };
  }

  let totalClosed = 0;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`[${botName}] Verify attempt ${attempt}/${maxRetries}: checking position...`);

    const pos = await getPositionForPair(pair);
    if (!pos || !pos.contracts || pos.contracts === 0) {
      log(`[${botName}] ✅ Confirmed flat — no position on Binance`);
      return { flat: true, forceClosed: totalClosed, error: null };
    }

    log(`[${botName}] ⚠ Position still open — sending close market order...`);
    const closed = await forceCloseDeals(pair);
    if (closed) {
      totalClosed++;
    } else {
      log(`[${botName}] Close market order failed — will retry...`);
    }

    // Wait for Binance to settle
    log(`[${botName}] Waiting 5s for Binance to settle...`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // Final check
  const finalPos = await getPositionForPair(pair);
  if (!finalPos || !finalPos.contracts || finalPos.contracts === 0) {
    log(`[${botName}] ✅ Confirmed flat after force-close`);
    return { flat: true, forceClosed: totalClosed, error: null };
  }

  const msg = `CRITICAL: ${botName} still has position on Binance after ${maxRetries} close attempts`;
  log(`[${botName}] ❌ ${msg}`);
  return { flat: false, forceClosed: totalClosed, error: msg };
}

/**
 * Get exchange position map (ground truth for ghost detection).
 * Returns Map<base, { symbol, side, size, entryPrice, markPrice, pnl, leverage, ... }>
 * Wrapper around binance-api.getPositionMap() but using CCXT directly.
 */
async function getExchangePositionMap() {
  const map = new Map();

  try {
    const exch = getExchange();
    const positions = await exch.fetchPositions(SUPPORTED_PAIRS);

    for (const pos of positions) {
      if (!pos.contracts || pos.contracts === 0) continue;

      const symbol = pos.symbol;
      const base = symbol.replace('USDT', '');
      const side = pos.side === 'long' ? 'LONG' : 'SHORT';

      map.set(base, {
        symbol,
        side,
        size: Math.abs(pos.contracts),
        entryPrice: pos.average || 0,
        markPrice: pos.markPrice || 0,
        pnl: pos.unrealizedPnl || 0,
        leverage: pos.leverage || 1,
        marginType: 'isolated',
        notional: (Math.abs(pos.contracts) * (pos.markPrice || 0)),
        positionAmt: pos.side === 'short' ? -pos.contracts : pos.contracts,
      });
    }

    log(`getExchangePositionMap: ${map.size} active position(s)${map.size > 0 ? ' — ' + [...map.entries()].map(([k, v]) => `${k} ${v.side} $${v.pnl.toFixed(2)}`).join(', ') : ''}`);
    return map;
  } catch (err) {
    log(`getExchangePositionMap error: ${err.message}`);
    return map; // Return empty map on error
  }
}

/**
 * Ensure bot is ready (noop in direct exchange mode, but set leverage/margin).
 * In old system: checked bot status and started if needed.
 * In new system: verify/set leverage and margin mode for the pair.
 */
async function ensureBotOpen(mongoIdOrPair, botName) {
  const pair = resolvePair(mongoIdOrPair);
  if (!pair) {
    return { wasOpen: true, error: null };
  }

  try {
    const exch = getExchange();

    // Set leverage to 10x if not already
    try {
      log(`[${botName}] Setting leverage to ${LEVERAGE}x for ${pair}...`);
      await exch.setLeverage(LEVERAGE, pair);
      log(`[${botName}] Leverage set to ${LEVERAGE}x`);
    } catch (leverageErr) {
      // Some pairs may have immutable leverage — not fatal
      if (leverageErr.message.includes('No permission to change leverage')) {
        log(`[${botName}] Leverage already set (no permission to change)`);
      } else {
        throw leverageErr;
      }
    }

    // Set margin mode to isolated
    try {
      log(`[${botName}] Setting margin mode to isolated for ${pair}...`);
      await exch.setMarginMode('isolated', pair);
      log(`[${botName}] Margin mode set to isolated`);
    } catch (marginErr) {
      // Some pairs may already be isolated — not fatal
      if (marginErr.message.includes('No need to change') || marginErr.message.includes('Identical')) {
        log(`[${botName}] Margin mode already isolated`);
      } else {
        throw marginErr;
      }
    }

    return { wasOpen: true, error: null };
  } catch (err) {
    log(`ensureBotOpen [${botName}] error: ${err.message}`);
    return { wasOpen: true, error: null }; // Don't block on setup errors
  }
}

/**
 * Create a new deal (open a position).
 * THE BIG ONE: Market order entry + SL setup.
 * @param {string} mongoIdOrPair — mongoId or pair
 * @param {string} botName — for logging
 * @returns {{ success: boolean, dealId: string|null, error: string|null, dealLimitReject: boolean }}
 */
async function createDeal(mongoIdOrPair, botName) {
  const config = resolveBotConfig(mongoIdOrPair);
  if (!config) {
    const msg = `Could not resolve bot config from ${mongoIdOrPair}`;
    log(`createDeal [${botName}]: ❌ ${msg}`);
    return { success: false, dealId: null, error: msg, dealLimitReject: false };
  }

  const pair = config.pair;
  const direction = config.direction;

  try {
    const exch = await ensureMarkets();

    // Get current mark price for position sizing
    const ticker = await exch.fetchTicker(pair);
    const markPrice = ticker.last;

    // Calculate quantity: $2,000 / markPrice, respecting pair precision
    const rawQty = POSITION_SIZE_USDT / markPrice;
    const quantity = parseFloat(exch.amountToPrecision(pair, rawQty));

    if (!quantity || quantity <= 0) {
      const msg = `Invalid quantity: ${quantity} at ${markPrice}`;
      log(`createDeal [${botName}] for ${pair}: ❌ ${msg}`);
      return { success: false, dealId: null, error: msg, dealLimitReject: false };
    }

    log(`createDeal [${botName}] for ${pair}: opening ${direction} ${quantity} contracts at ~$${markPrice}`);

    // Place market order
    const side = direction === 'LONG' ? 'buy' : 'sell';
    const order = await exch.createMarketOrder(pair, side, quantity);
    const orderId = order.id;

    // Get filled price
    const filledPrice = order.average || markPrice;
    log(`createDeal [${botName}]: ✅ Market order filled (ID: ${orderId}, avg price: $${filledPrice})`);

    // Place stop-loss order at -0.5% from fill price
    // LONG SL = below entry (price drops), SHORT SL = above entry (price rises)
    const slMultiplier = direction === 'LONG'
      ? (1 + SL_PERCENT / 100)    // e.g. 0.995 — below entry
      : (1 - SL_PERCENT / 100);   // e.g. 1.005 — above entry
    const rawSlPrice = filledPrice * slMultiplier;
    const stopPrice = parseFloat(exch.priceToPrecision(pair, rawSlPrice));
    const slSide = direction === 'LONG' ? 'sell' : 'buy';

    log(`createDeal [${botName}]: placing SL at $${stopPrice} (${SL_PERCENT}% from $${filledPrice}, side: ${slSide})`);

    // CCXT STOP_MARKET order: closes the entire position when stop is hit
    const slOrder = await exch.createOrder(
      pair,
      'STOP_MARKET',
      slSide,
      quantity,
      null,
      { stopPrice, closePosition: true }
    );
    const slOrderId = slOrder.id;

    log(`createDeal [${botName}]: ✅ SL order placed (ID: ${slOrderId}, stopPrice: $${stopPrice})`);

    return {
      success: true,
      dealId: orderId,
      error: null,
      dealLimitReject: false,
    };
  } catch (err) {
    const msg = err.message;

    // Detect transient rejections (rate limits, insufficient margin, etc.)
    const lowerMsg = msg.toLowerCase();
    const isDealLimitReject = lowerMsg.includes('rate limit') ||
                              lowerMsg.includes('too many') ||
                              lowerMsg.includes('insufficient') ||
                              lowerMsg.includes('margin');

    log(`createDeal [${botName}] for ${pair}: ❌ ${msg}${isDealLimitReject ? ' [DEAL-LIMIT]' : ''}`);

    return {
      success: false,
      dealId: null,
      error: msg,
      dealLimitReject: isDealLimitReject,
    };
  }
}

// ── Public API ───────────────────────────────────────────────────────────

module.exports = {
  isConfigured,
  getBotDeals,
  getAllBotStatuses,
  listOpenDeals,
  listAllOpenDeals,
  forceCloseDeals,
  closeDealsViaApi,
  verifyAndForceClose,
  getExchangePositionMap,
  ensureBotOpen,
  createDeal,
};
