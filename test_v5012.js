#!/usr/bin/env node
/**
 * v5.0.12 Verification Harness
 *
 * Monkey-patches ccxt.binanceusdm BEFORE exchange-api.js loads it, feeds
 * fake CCXT responses, and asserts that the real exported functions
 * produce correct output for every scenario that was broken pre-v5.0.12.
 *
 * No network calls. No real positions. No money at risk.
 */

'use strict';

const ccxt = require('ccxt');

// ── State: mutated per test scenario ──────────────────────────────────
let FAKE_POSITIONS = [];

// ── Monkey-patch CCXT before exchange-api.js loads ────────────────────
class FakeBinanceUSDM {
  constructor(opts) {
    this.opts = opts;
    this.markets = {};
  }
  async loadMarkets() { return {}; }
  async fetchPositions(symbols) {
    // Real CCXT filters by the symbols array — mimic that behavior.
    // symbols may be raw (SOLUSDT) or unified (SOL/USDT:USDT).
    let filtered = FAKE_POSITIONS;
    if (symbols && symbols.length > 0) {
      filtered = FAKE_POSITIONS.filter(p => {
        for (const s of symbols) {
          const sBase = s.includes('/') ? s.split('/')[0] : s.replace('USDT', '');
          const pBase = p.symbol.includes('/') ? p.symbol.split('/')[0] : p.symbol.replace('USDT', '');
          if (sBase === pBase) return true;
        }
        return false;
      });
    }
    return JSON.parse(JSON.stringify(filtered));
  }
  async fetchBalance() {
    return { total: { USDT: 1156.64 }, free: { USDT: 1156.64 }, used: { USDT: 0 } };
  }
  market(symbol) {
    return { id: symbol.replace(/[\/:]/g, ''), symbol };
  }
  amountToPrecision(symbol, qty) { return qty.toFixed(2); }
  priceToPrecision(symbol, price) { return price.toFixed(2); }
}
ccxt.binanceusdm = FakeBinanceUSDM;

// Stub env vars so isConfigured() returns true
process.env.BINANCE_API_KEY = 'test-key';
process.env.BINANCE_API_SECRET = 'test-secret';

// NOW load the real exchange-api.js module
const api = require('/Users/ctu2/signal-bot-router/src/exchange-api');

// ── UUIDs from BOT_MAP (must match exchange-api.js) ───────────────────
const SOL_LONG  = '61a66c9f-7463-46db-a72f-2ef39565bc20';
const SOL_SHORT = '3af77f4f-73a7-45c1-a0fd-b7c3ce9f16ee';
const ETH_LONG  = '4d6f6265-4c9a-42e7-bf85-8956a1c03f6c';
const ETH_SHORT = '69c91263-68c9-4f88-a543-7c319b5fde8b';
const BTC_LONG  = '21c9985a-db38-4409-af79-26f389d32d0a';
const BTC_SHORT = 'd0ea54dc-7218-4662-b2bf-0c66f4be9e44';
const SOL_LONG_MONGO  = '69ce1dc4228af151def7f93e';
const SOL_SHORT_MONGO = '69ce1dc6228af151def7f97b';

// ── Test runner ────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function scenario(name) {
  console.log(`\n── ${name} ──`);
}

function makePos(symbol, side, contracts, avgPrice = 83.60, pnl = -2.95) {
  return {
    symbol,
    side,
    contracts,
    contractSize: 1,
    average: avgPrice,
    entryPrice: avgPrice,
    markPrice: avgPrice + (side === 'long' ? 0.05 : -0.05),
    unrealizedPnl: pnl,
    leverage: 10,
    info: {},
  };
}

// ──────────────────────────────────────────────────────────────────────
async function run() {
  // ── Scenario 1: No positions ─────────────────────────────────────────
  scenario('Scenario 1 — No open positions');
  FAKE_POSITIONS = [];

  const emptyMap = await api.getExchangePositionMap();
  assert(emptyMap.size === 0, 'getExchangePositionMap returns empty map');

  const emptyStatuses = await api.getAllBotStatuses();
  assert(emptyStatuses.size === 8, 'getAllBotStatuses returns entries for all 8 bots');
  let allClosed = true;
  for (const [, st] of emptyStatuses) {
    if (st.deals.active !== 0) allClosed = false;
  }
  assert(allClosed, 'All 8 bots reported as closed (0 active deals)');

  const emptyBotDeals = await api.getBotDeals(SOL_LONG);
  assert(emptyBotDeals.active === 0 && emptyBotDeals.all === 0, 'getBotDeals reports 0 for SOL_LONG');

  const emptyOpenDeals = await api.listOpenDeals(SOL_LONG_MONGO);
  assert(emptyOpenDeals.length === 0, 'listOpenDeals returns empty array');

  // ── Scenario 2: SOL SHORT open — the exact yesterday scenario ───────
  scenario('Scenario 2 — SOL SHORT open (yesterday\'s flip-loop scenario)');
  FAKE_POSITIONS = [makePos('SOL/USDT:USDT', 'short', 17.94, 83.60, -2.95)];

  const solMap = await api.getExchangePositionMap();
  assert(solMap.size === 1, 'Map has exactly 1 position');
  assert(solMap.has('SOL'), 'Map keyed under "SOL" (the v5.0.8 symbol-parse fix)');
  assert(!solMap.has('SOL/:USDT'), 'Map NOT keyed under broken "SOL/:USDT"');
  const solPos = solMap.get('SOL');
  assert(solPos && solPos.side === 'SHORT', 'Side normalized to uppercase "SHORT"');

  const solStatuses = await api.getAllBotStatuses();
  assert(solStatuses.get(SOL_SHORT).deals.active === 1, 'SOL Short v2 marked ACTIVE');
  assert(solStatuses.get(SOL_LONG).deals.active === 0, 'SOL Long v2 NOT marked active (v5.0.9 direction fix)');
  assert(solStatuses.get(ETH_LONG).deals.active === 0, 'ETH Long v2 NOT marked active');
  assert(solStatuses.get(BTC_LONG).deals.active === 0, 'BTC Long v2 NOT marked active');

  const solShortDeals = await api.getBotDeals(SOL_SHORT);
  assert(solShortDeals.active === 1, 'getBotDeals(SOL_SHORT) returns active=1');
  const solLongDeals = await api.getBotDeals(SOL_LONG);
  assert(solLongDeals.active === 0, 'getBotDeals(SOL_LONG) returns active=0 (direction-aware)');

  const solShortOpen = await api.listOpenDeals(SOL_SHORT_MONGO);
  assert(solShortOpen.length === 1, 'listOpenDeals(SOL_SHORT_MONGO) returns 1 deal');
  const solLongOpen = await api.listOpenDeals(SOL_LONG_MONGO);
  assert(solLongOpen.length === 0, 'listOpenDeals(SOL_LONG_MONGO) returns empty (direction filter)');

  // ── Scenario 3: SOL LONG open — mirror test ─────────────────────────
  scenario('Scenario 3 — SOL LONG open (mirror of Scenario 2)');
  FAKE_POSITIONS = [makePos('SOL/USDT:USDT', 'long', 17.91, 83.76, 1.50)];

  const longMap = await api.getExchangePositionMap();
  assert(longMap.get('SOL').side === 'LONG', 'Map shows SOL as LONG');
  const longStatuses = await api.getAllBotStatuses();
  assert(longStatuses.get(SOL_LONG).deals.active === 1, 'SOL Long v2 marked ACTIVE');
  assert(longStatuses.get(SOL_SHORT).deals.active === 0, 'SOL Short v2 NOT marked active');

  // ── Scenario 4: Multiple pairs, mixed directions ────────────────────
  scenario('Scenario 4 — All 4 pairs open, mixed directions');
  FAKE_POSITIONS = [
    makePos('SOL/USDT:USDT', 'long', 17.91, 83.76),
    makePos('ETH/USDT:USDT', 'short', 0.63, 2379.00),
    makePos('XRP/USDT:USDT', 'long', 1086, 1.38),
    makePos('BTC/USDT:USDT', 'short', 0.02, 74711.00),
  ];

  const multiMap = await api.getExchangePositionMap();
  assert(multiMap.size === 4, 'Map has 4 positions');
  assert(multiMap.has('SOL') && multiMap.has('ETH') && multiMap.has('XRP') && multiMap.has('BTC'),
    'All 4 keys present (SOL, ETH, XRP, BTC)');
  assert(multiMap.get('SOL').side === 'LONG', 'SOL is LONG');
  assert(multiMap.get('ETH').side === 'SHORT', 'ETH is SHORT');
  assert(multiMap.get('XRP').side === 'LONG', 'XRP is LONG');
  assert(multiMap.get('BTC').side === 'SHORT', 'BTC is SHORT');

  const multiStatuses = await api.getAllBotStatuses();
  assert(multiStatuses.get(SOL_LONG).deals.active === 1, 'SOL Long active');
  assert(multiStatuses.get(SOL_SHORT).deals.active === 0, 'SOL Short not active');
  assert(multiStatuses.get(ETH_SHORT).deals.active === 1, 'ETH Short active');
  assert(multiStatuses.get(ETH_LONG).deals.active === 0, 'ETH Long not active');
  assert(multiStatuses.get(BTC_SHORT).deals.active === 1, 'BTC Short active (v5.0.9 BOT_MAP fix)');
  assert(multiStatuses.get(BTC_LONG).deals.active === 0, 'BTC Long not active');

  // ── Scenario 5: Reval lookup simulation ─────────────────────────────
  scenario('Scenario 5 — Simulate reval lookup (the exact broken code path)');
  FAKE_POSITIONS = [makePos('SOL/USDT:USDT', 'short', 17.94, 83.60, -2.95)];

  // This is EXACTLY what reval does in server.js line 1815-1820:
  const cachedPosMap = await api.getExchangePositionMap();
  const bot_pair = 'SOLUSDT'; // from BOT_MAP[uuid].pair
  const base = bot_pair.replace('USDT', '').replace('/USDT', ''); // same code as reval
  const pos = cachedPosMap.get(base);

  assert(base === 'SOL', 'Reval derives base correctly: "SOL"');
  assert(pos !== undefined, 'Reval FOUND the position (would NOT trigger false external-close)');
  assert(pos && pos.side === 'SHORT', 'Reval sees correct side: SHORT');

  // ── Scenario 6: BOT_MAP consolidation ────────────────────────────────
  scenario('Scenario 6 — BOT_MAP export and BTC UUID fix (v5.0.9)');
  assert(api.BOT_MAP !== undefined, 'BOT_MAP is exported from exchange-api.js');
  assert(Object.keys(api.BOT_MAP).length === 8, 'BOT_MAP has exactly 8 entries');
  assert(api.BOT_MAP[BTC_LONG] && api.BOT_MAP[BTC_LONG].name === 'BTC Long v2',
    'BTC Long UUID 21c9985a-...4409 maps to "BTC Long v2" (matches TradingView)');
  assert(api.BOT_MAP[BTC_SHORT] && api.BOT_MAP[BTC_SHORT].name === 'BTC Short v2',
    'BTC Short UUID d0ea54dc-...4662 maps to "BTC Short v2" (matches TradingView)');
  // Negative test: the old wrong UUIDs from server.js should NOT exist
  assert(!api.BOT_MAP['d0ea54dc-7218-4666-8c81-85bcd0271a3f'],
    'Old wrong BTC UUID d0ea54dc-...4666 is NOT in BOT_MAP');
  assert(!api.BOT_MAP['21c9985a-db38-440d-9313-ac13825852be'],
    'Old wrong BTC UUID 21c9985a-...440d is NOT in BOT_MAP');

  // ── Summary ──────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));
  if (failed > 0) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log(`  ✗ ${f}`));
    process.exit(1);
  } else {
    console.log('\n🎉 All v5.0.12 bug-fix scenarios verified.');
    process.exit(0);
  }
}

run().catch(err => {
  console.error('TEST HARNESS ERROR:', err);
  process.exit(2);
});
