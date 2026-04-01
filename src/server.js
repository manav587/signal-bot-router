const express = require('express');
const app = express();
const gainiumApi = require('./gainium-api');
const signalGate = require('./signal-gate');
const fundingStrategy = require('./funding-strategy');

// Parse both JSON and plain text bodies (TradingView sends text/plain when message has emoji prefix)
app.use(express.json());
app.use(express.text({ type: '*/*' }));

const GAINIUM_WEBHOOK_URL = 'https://api.gainium.io/trade_signal';

// ── UUID → MongoDB ID mapping (for API verification) ────────────────────
// The relay needs MongoDB ObjectIds to call get_bot / manage_deal.
// UUID is what TradingView sends; Mongo ID is what the Gainium REST API uses.
const BOT_MAP = {
  '108babeb-649f-46ec-8ce8-c8a63a863b39': { mongoId: '69c4ab944c428a9d6a6c2c5d', name: 'ETH Long v2' },
  '65db6bc2-353c-4590-940a-32bd64f4d3c9': { mongoId: '69c4ab9c4c428a9d6a6c2d07', name: 'ETH Short v2' },
  'b7d03686-a657-4ced-ad0a-225d28c71ab8': { mongoId: '69c8e321c0cb070ef82a064e', name: 'SOL Long v2' },
  '87956a3c-4c24-46d1-b071-cd3e6e35c761': { mongoId: '69c4ab8b4c428a9d6a6c2bcb', name: 'SOL Short v2' },
  '7bd0c5be-6a0e-4d0e-946d-f957ef5a8236': { mongoId: '69c6cb76c0cb070ef8ea2fb8', name: 'XRP Long v2' },
  '14ea2ce8-c0cd-4eaf-b9b0-54c6ac325921': { mongoId: '69c6cb77c0cb070ef8ea2fd5', name: 'XRP Short v2' },
  'b3f25502-d982-4c6e-a29a-ce2c8cef5349': { mongoId: '69ccbd69fdc61f1b4550190a', name: 'BTC Long v2' },
  'c302bc15-990c-4722-aba9-1d27b1f549d4': { mongoId: '69ccbd6afdc61f1b4550191e', name: 'BTC Short v2' },
};

// ── Telegram Alerts (optional — sends critical failures to Manav) ────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log(`⚠ Telegram not configured — alert not sent: ${message}`);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    log(`Telegram send failed: ${err.message}`);
  }
}

// ── Pause Mode (v1.5.0) ─────────────────────────────────────────────────
// When paused, the relay logs incoming signals to Telegram but skips execution.
// This lets you see what TradingView is sending without any bots being started.
let PAUSED = false;
let PAUSED_AT = null;    // ISO timestamp of when pause was activated
let PAUSED_SIGNALS = 0;  // Count of signals received while paused

// ── Strategy Toggle (v2.2.0) ────────────────────────────────────────────
// Switch between signal sources. Only one active at a time.
//   'crossover' = TradingView EMA crossover alerts (default, current system)
//   'funding'   = Binance funding rate mean-reversion (polls every 4h)
let STRATEGY_MODE = 'crossover';
let STRATEGY_CHANGED_AT = null;
let FUNDING_POLL_TIMER = null;
const FUNDING_POLL_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

// ── Active Bot Tracker (v1.7.1) ────────────────────────────────────────
// Tracks which bots the relay has started, so we can re-validate them.
// Key = UUID, Value = { pair, direction, botName, startedAt }
// Only populated when the relay dispatches a startBot action.
const ACTIVE_BOTS = {};

// ── Rising-Edge Detection (v1.5.1) ─────────────────────────────────────
// Tracks the last dispatched direction per trading pair.
// If a signal wants to flip to the SAME direction we already dispatched,
// it's a duplicate (sustained crossover state, not a new transition) — drop it.
//
// Key = pair name (e.g. 'SOLUSDT'), Value = 'LONG' | 'SHORT' | null
const LAST_DIRECTION = {};

// ── Flip Cooldown (v1.9.0) ─────────────────────────────────────────────
// After an auto-flip, block further auto-flips on that pair for 10 minutes.
// TradingView signals still pass — only relay-initiated auto-flips are throttled.
// Key = pair name, Value = ISO timestamp of last auto-flip
const FLIP_COOLDOWN = {};
const FLIP_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function isFlipOnCooldown(pair) {
  const lastFlip = FLIP_COOLDOWN[pair];
  if (!lastFlip) return false;
  return (Date.now() - new Date(lastFlip).getTime()) < FLIP_COOLDOWN_MS;
}

// ── Circuit Breaker (v1.9.0) ───────────────────────────────────────────
// 3 flips (auto-flip OR TradingView-triggered) on the same pair within 15 min
// = park that pair for 30 min. During park: no auto-flips, no TradingView signals.
// Key = pair name, Value = { flips: [timestamps], parkedUntil: ISO | null }
const CIRCUIT_BREAKER = {};
const CB_FLIP_THRESHOLD = 3;
const CB_WINDOW_MS = 15 * 60 * 1000;   // 15-minute window
const CB_PARK_MS = 30 * 60 * 1000;     // 30-minute park duration

function recordFlip(pair) {
  if (!CIRCUIT_BREAKER[pair]) {
    CIRCUIT_BREAKER[pair] = { flips: [], parkedUntil: null };
  }
  CIRCUIT_BREAKER[pair].flips.push(Date.now());
  // Prune old flips outside the window
  const cutoff = Date.now() - CB_WINDOW_MS;
  CIRCUIT_BREAKER[pair].flips = CIRCUIT_BREAKER[pair].flips.filter(t => t > cutoff);
}

function checkCircuitBreaker(pair) {
  const cb = CIRCUIT_BREAKER[pair];
  if (!cb) return { parked: false };

  // Check if currently parked
  if (cb.parkedUntil && Date.now() < new Date(cb.parkedUntil).getTime()) {
    const remainMs = new Date(cb.parkedUntil).getTime() - Date.now();
    return { parked: true, remainMs, reason: `Circuit breaker active — parked until ${cb.parkedUntil}` };
  }

  // Clear expired park
  if (cb.parkedUntil) cb.parkedUntil = null;

  // Check if threshold reached
  const cutoff = Date.now() - CB_WINDOW_MS;
  const recentFlips = cb.flips.filter(t => t > cutoff);
  if (recentFlips.length >= CB_FLIP_THRESHOLD) {
    // TRIP the breaker
    cb.parkedUntil = new Date(Date.now() + CB_PARK_MS).toISOString();
    return { parked: true, tripped: true, remainMs: CB_PARK_MS, reason: `${recentFlips.length} flips in ${CB_WINDOW_MS / 60000} min — parking for ${CB_PARK_MS / 60000} min` };
  }

  return { parked: false };
}

/**
 * Detect the target direction and pair from a signal's action sequence.
 * A crossover flip has: closeAllDeals(old) → stopBot(old) → startBot(new)
 * The direction comes from the startBot target bot name (contains "Long" or "Short").
 * The pair comes from BOT_MAP.
 *
 * @returns {{ pair: string, direction: string } | null}
 */
function detectSignalDirection(actions) {
  const startAction = actions.find(a => a.action === 'startBot');
  if (!startAction || !startAction.uuid) return null;

  const bot = BOT_MAP[startAction.uuid];
  if (!bot) return null;

  // Extract direction from bot name: "ETH Long v2" → "LONG", "SOL Short v2" → "SHORT"
  const direction = bot.name.toLowerCase().includes('long') ? 'LONG' :
                    bot.name.toLowerCase().includes('short') ? 'SHORT' : null;
  if (!direction) return null;

  // Extract pair from bot name: "ETH Long v2" → "ETH", "SOL Short v2" → "SOL"
  const pair = bot.name.split(' ')[0].toUpperCase();

  return { pair, direction, botName: bot.name };
}

// ── Bot Lookup by Pair + Direction ──────────────────────────────────────
// Find bot UUID given a pair and direction. Used by both flip logic and funding strategy.
// e.g. ("SOL", "LONG") → { uuid: '...', mongoId: '...', name: 'SOL Long v2' }
function findBot(pair, direction) {
  const dirLabel = direction === 'LONG' ? 'Long' : 'Short';
  const targetName = `${pair} ${dirLabel} v2`;
  for (const [uuid, bot] of Object.entries(BOT_MAP)) {
    if (bot.name === targetName) return { uuid, ...bot };
  }
  return null;
}

// ── Opposite Bot Lookup (v1.8.0) ────────────────────────────────────────
// Given a pair and direction, find the UUID of the opposite-direction bot.
// e.g. ("SOL", "SHORT") → UUID of "SOL Long v2"
function findOppositeBot(pair, direction) {
  const oppositeDir = direction === 'LONG' ? 'Short' : 'Long';
  const targetName = `${pair} ${oppositeDir} v2`;
  for (const [uuid, bot] of Object.entries(BOT_MAP)) {
    if (bot.name === targetName) return { uuid, ...bot };
  }
  return null;
}

// ── Funding Strategy Execution (v2.2.0) ─────────────────────────────────
// When STRATEGY_MODE is 'funding', this runs every 4 hours.
// Checks funding rates for all pairs and dispatches trades through the
// same pipeline as TradingView signals (same bots, same gates, same everything).

async function runFundingCheck() {
  if (STRATEGY_MODE !== 'funding') return;
  if (PAUSED) {
    log('[FUNDING] System is paused — skipping funding check');
    return;
  }

  log('[FUNDING] Running funding rate check across all pairs...');

  try {
    const results = await fundingStrategy.checkAllPairs();

    for (const result of results) {
      if (!result.signal) {
        log(`[FUNDING] ${result.pair}: No signal — ${result.data.reason}`);
        continue;
      }

      const { pair, signal: direction } = result;
      const requestId = 'fund-' + Math.random().toString(36).substring(2, 8);

      log(`[${requestId}] [FUNDING] ${pair} signal: ${direction} — ${result.data.reason}`);

      // Rising-edge: skip if same direction already active
      if (LAST_DIRECTION[pair] === direction) {
        log(`[${requestId}] [FUNDING] 🔇 ${pair} already ${direction} — skipping`);
        continue;
      }

      // Circuit breaker check
      const cbCheck = checkCircuitBreaker(pair);
      if (cbCheck.parked) {
        log(`[${requestId}] [FUNDING] ⚡ ${pair} parked by circuit breaker — skipping`);
        continue;
      }

      // Run signal gate (same 2 blocking gates as crossover)
      const gateResult = await signalGate.validateSignal(pair, direction);
      if (!gateResult.allowed) {
        log(`[${requestId}] [FUNDING] 🚫 ${pair} ${direction} gated: ${gateResult.reason}`);
        sendTelegramAlert(
          `🚫 Funding Signal Gated\n\n` +
          `${pair} ${direction} → BLOCKED\n` +
          `Funding: ${result.data.fundingPct}\n` +
          `Reason: ${gateResult.reason}\n` +
          `Time: ${istTimestamp()}\n` +
          `Request: ${requestId}`
        ).catch(() => {});
        continue;
      }

      // Build action array — same format as TradingView alerts
      const targetBot = findBot(pair, direction);
      const oppositeBot = findOppositeBot(pair, direction);

      if (!targetBot) {
        log(`[${requestId}] [FUNDING] ❌ No bot found for ${pair} ${direction}`);
        continue;
      }

      const actions = [];

      // If there's an active opposite bot, close its deals and stop it first
      if (oppositeBot) {
        actions.push({ action: 'closeAllDeals', uuid: oppositeBot.uuid });
        actions.push({ action: 'stopBot', uuid: oppositeBot.uuid });
      }

      // Start the target bot
      actions.push({ action: 'startBot', uuid: targetBot.uuid });

      // Update tracking
      LAST_DIRECTION[pair] = direction;
      recordFlip(pair);
      fundingStrategy.recordSignal(result.data.symbol, direction);

      // Track active bot for revalidation
      ACTIVE_BOTS[targetBot.uuid] = {
        pair,
        direction,
        botName: targetBot.name,
        startedAt: new Date().toISOString(),
      };
      if (oppositeBot) {
        delete ACTIVE_BOTS[oppositeBot.uuid];
      }

      // Send Telegram notification
      sendTelegramAlert(
        `📊 Funding Rate Signal\n\n` +
        `${pair} → ${direction}\n` +
        `Funding: ${result.data.fundingPct}\n` +
        `Price: $${result.data.markPrice?.toFixed(2) || '?'}\n` +
        `Gate: ${gateResult.reason}\n` +
        `Actions: ${actions.map(a => a.action).join(' → ')}\n` +
        `Time: ${istTimestamp()}\n` +
        `Request: ${requestId}`
      ).catch(() => {});

      // Execute through the same pipeline
      log(`[${requestId}] [FUNDING] Dispatching: ${actions.map(a => `${a.action}(${a.uuid.substring(0, 8)})`).join(' → ')}`);
      processActions(actions, requestId).catch(err => {
        log(`[${requestId}] [FUNDING] ❌ Execution error: ${err.message}`);
      });
    }
  } catch (err) {
    log(`[FUNDING] ❌ Check failed: ${err.message}`);
  }
}

function startFundingPoller() {
  if (FUNDING_POLL_TIMER) clearInterval(FUNDING_POLL_TIMER);
  // Run immediately on start, then every 4 hours
  runFundingCheck();
  FUNDING_POLL_TIMER = setInterval(runFundingCheck, FUNDING_POLL_INTERVAL);
  log(`[FUNDING] Poller started — checking every ${FUNDING_POLL_INTERVAL / (60 * 60 * 1000)}h`);
}

function stopFundingPoller() {
  if (FUNDING_POLL_TIMER) {
    clearInterval(FUNDING_POLL_TIMER);
    FUNDING_POLL_TIMER = null;
  }
  log('[FUNDING] Poller stopped');
}

// ── Deferred Flip Queue (v1.3.0) ─────────────────────────────────────────
// When a flip aborts due to Gainium outage, queue it for retry.
// Retries every 60s for up to 5 minutes, then gives up with a Telegram alert.
const DEFERRED_QUEUE = []; // { actions, requestId, targetBot, queuedAt, retryCount }
const DEFERRED_MAX_RETRIES = 5;      // 5 retries × 60s = 5 minutes
const DEFERRED_RETRY_INTERVAL = 60000; // 60 seconds

function queueDeferredFlip(actions, requestId, targetBot) {
  // Don't double-queue the same bot
  const existing = DEFERRED_QUEUE.find(q => q.targetBot.mongoId === targetBot.mongoId);
  if (existing) {
    log(`[${requestId}] Deferred flip already queued for ${targetBot.name} (req ${existing.requestId}) — skipping`);
    return;
  }

  DEFERRED_QUEUE.push({
    actions,
    requestId,
    targetBot,
    queuedAt: Date.now(),
    retryCount: 0,
  });

  log(`[${requestId}] 📋 Queued deferred flip for ${targetBot.name} — will retry every 60s for up to 5 min`);
  sendTelegramAlert(
    `📋 Flip Queued for Retry\n\n` +
    `Bot: ${targetBot.name}\n` +
    `Will retry every 60s for up to 5 min\n` +
    `Time: ${istTimestamp()}\n` +
    `Request: ${requestId}`
  ).catch(() => {});
}

async function processDeferredQueue() {
  if (DEFERRED_QUEUE.length === 0) return;

  // Process a copy so we can safely remove entries
  for (let i = DEFERRED_QUEUE.length - 1; i >= 0; i--) {
    const item = DEFERRED_QUEUE[i];
    item.retryCount++;

    log(`[${item.requestId}] 🔄 Deferred retry ${item.retryCount}/${DEFERRED_MAX_RETRIES} for ${item.targetBot.name}...`);

    // Re-attempt the full action sequence
    try {
      const result = await processActions(item.actions, item.requestId + `-r${item.retryCount}`, true);

      if (result && result.completed) {
        log(`[${item.requestId}] ✅ Deferred flip SUCCEEDED for ${item.targetBot.name} on retry ${item.retryCount}`);
        sendTelegramAlert(
          `✅ Deferred Flip Succeeded\n\n` +
          `Bot: ${item.targetBot.name}\n` +
          `Retry: ${item.retryCount}/${DEFERRED_MAX_RETRIES}\n` +
          `Time: ${istTimestamp()}\n` +
          `Request: ${item.requestId}`
        ).catch(() => {});
        DEFERRED_QUEUE.splice(i, 1);
        continue;
      }
    } catch (err) {
      log(`[${item.requestId}] Deferred retry error: ${err.message}`);
    }

    // Check if we've exhausted retries
    if (item.retryCount >= DEFERRED_MAX_RETRIES) {
      log(`[${item.requestId}] ❌ Deferred flip GAVE UP for ${item.targetBot.name} after ${DEFERRED_MAX_RETRIES} retries`);
      sendTelegramAlert(
        `❌ Deferred Flip Failed\n\n` +
        `Bot: ${item.targetBot.name}\n` +
        `Gave up after ${DEFERRED_MAX_RETRIES} retries (5 min)\n` +
        `Manual intervention required.\n` +
        `Time: ${istTimestamp()}\n` +
        `Request: ${item.requestId}`
      ).catch(() => {});
      DEFERRED_QUEUE.splice(i, 1);
    }
  }
}

// Run the deferred queue processor every 60 seconds
setInterval(processDeferredQueue, DEFERRED_RETRY_INTERVAL);

// Delays between action types (milliseconds)
const DELAYS = {
  closeAllDeals: 5000,  // 5s — wait for Binance to clear the position
  closeDealSl:   5000,  // 5s — same as closeAllDeals
  stopBot:       2000,  // 2s — let bot state settle
  startBot:      3000,  // 3s — let bot initialize before startDeal (v2.3.0)
  startDeal:     0,     // No delay needed after deal start
  addFunds:      0,
};

// Timestamp in IST (UTC+5:30) for Manav
function istTimestamp() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function log(msg) {
  console.log(`[${istTimestamp()}] ${msg}`);
}

// Extract JSON array from body — handles both pure JSON and "emoji text [json]" format
function extractActions(body) {
  if (typeof body === 'object' && Array.isArray(body)) {
    return body; // Already parsed as JSON array
  }

  const raw = typeof body === 'object' ? JSON.stringify(body) : String(body);

  // Find the first [ and last ] to extract the JSON array
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(raw.substring(start, end + 1));
  } catch (e) {
    return null;
  }
}

// Send a single action to Gainium's webhook endpoint (10s timeout, 1 retry)
async function sendAction(action, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(GAINIUM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([action]),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { status: response.status, ok: true };
  } catch (err) {
    clearTimeout(timeout);
    if (attempt < 2) {
      const actionName = action.action || 'unknown';
      log(`  ⚠ ${actionName} failed (${err.name === 'AbortError' ? 'timeout' : err.message}), retrying in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
      return sendAction(action, attempt + 1);
    }
    throw err;
  }
}

// ── v1.2.0: Verification logic after closeAllDeals ──────────────────────

/**
 * Find the bot being CLOSED in this action sequence.
 * When a crossover fires, closeAllDeals targets the OLD bot (the one being stopped).
 * The closeAllDeals action contains the UUID of the bot whose deals need closing.
 */
function findCloseTargetBot(actions) {
  const closeAction = actions.find(a => a.action === 'closeAllDeals');
  if (!closeAction || !closeAction.uuid) return null;

  const bot = BOT_MAP[closeAction.uuid];
  if (!bot) {
    log(`⚠ closeAllDeals UUID ${closeAction.uuid} not found in BOT_MAP`);
    return null;
  }
  return { uuid: closeAction.uuid, ...bot };
}

/**
 * v1.2.0 enhanced close: double-tap closeAllDeals, then verify and force-close.
 *
 * Flow:
 *   1. Send closeAllDeals (first tap — already done by caller)
 *   2. Wait 3s, send closeAllDeals again (double-tap)
 *   3. Wait 5s for Binance to process
 *   4. Call get_bot → check deals.active
 *   5. If deals remain → force-close via manage_deal
 *   6. Re-verify deals.active == 0
 *   7. If STILL not flat → alert and ABORT (do not proceed to startBot)
 *
 * @returns {{ verified: boolean, abortRemaining: boolean }}
 */
async function verifyCloseAllDeals(closeAction, targetBot, requestId) {
  // Step 1: Double-tap — send closeAllDeals again
  log(`[${requestId}]   🔁 Double-tap: sending closeAllDeals again for ${targetBot.name}...`);
  await new Promise(r => setTimeout(r, 3000));

  try {
    await sendAction(closeAction);
    log(`[${requestId}]   ✓ Double-tap closeAllDeals sent`);
  } catch (err) {
    log(`[${requestId}]   ⚠ Double-tap failed: ${err.message} (continuing to verify)`);
  }

  // Step 2: Wait for Binance to process
  log(`[${requestId}]   ⏳ Waiting 5s for Binance to settle...`);
  await new Promise(r => setTimeout(r, 5000));

  // Step 3: Verify via Gainium REST API
  if (!gainiumApi.isConfigured()) {
    log(`[${requestId}]   ⚠ Gainium API not configured (GAINIUM_API_KEY/SECRET missing) — skipping verification`);
    return { verified: false, abortRemaining: false };
  }

  const result = await gainiumApi.verifyAndForceClose(targetBot.uuid, targetBot.mongoId, targetBot.name);

  if (result.flat) {
    if (result.forceClosed > 0) {
      log(`[${requestId}]   ✅ Verified flat — force-closed ${result.forceClosed} deal(s)`);
    } else {
      log(`[${requestId}]   ✅ Verified flat — closeAllDeals worked correctly`);
    }
    return { verified: true, abortRemaining: false };
  }

  // NOT FLAT — this is critical. Do NOT proceed to startBot.
  const alertMsg = `🚨 FLIP ABORTED for ${targetBot.name}\n\n${result.error}\n\nManual intervention required. The opposite bot was NOT started to prevent position conflict.`;
  log(`[${requestId}]   🚨 ${alertMsg}`);
  await sendTelegramAlert(alertMsg);

  return { verified: false, abortRemaining: true };
}

// ── Process actions sequentially with delays ─────────────────────────────

async function processActions(actions, requestId, isRetry = false) {
  // v2.3.0: Auto-inject startDeal after every startBot.
  // Bots use startCondition=Manual to prevent ASAP deal churning.
  // The relay explicitly opens exactly ONE deal per signal.
  const expanded = [];
  for (const a of actions) {
    expanded.push(a);
    if (a.action === 'startBot' && a.uuid) {
      expanded.push({ action: 'startDeal', uuid: a.uuid });
      log(`[${requestId}]   ↳ Auto-injected startDeal for ${BOT_MAP[a.uuid]?.name || a.uuid.substring(0, 8)}`);
    }
  }
  actions = expanded;

  log(`[${requestId}] Processing ${actions.length} action(s)${isRetry ? ' (deferred retry)' : ''}...`);

  // v1.2.0: Identify if this is a crossover flip (has closeAllDeals)
  const targetBot = findCloseTargetBot(actions);
  let abortRemaining = false;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const actionName = action.action || 'unknown';
    const uuid = action.uuid || 'no-uuid';
    const shortUuid = uuid.substring(0, 8);

    // v1.2.0: If verification failed, abort remaining actions (stopBot is OK, but skip startBot/startDeal)
    if (abortRemaining && (actionName === 'startBot' || actionName === 'startDeal')) {
      log(`[${requestId}]   ⛔ SKIPPED ${actionName} → ${shortUuid}... (abort: deals not confirmed closed)`);
      continue;
    }

    log(`[${requestId}]   ${i + 1}/${actions.length}: ${actionName} → ${shortUuid}...`);

    try {
      const result = await sendAction(action);
      log(`[${requestId}]   ✓ ${actionName} returned ${result.status}`);
    } catch (err) {
      log(`[${requestId}]   ✗ ${actionName} FAILED after retry: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
      // Continue with remaining actions — don't let one failure block the rest
    }

    // v1.2.0: After closeAllDeals, run verification before proceeding
    if (actionName === 'closeAllDeals' && targetBot) {
      const verifyResult = await verifyCloseAllDeals(action, targetBot, requestId);
      if (verifyResult.abortRemaining) {
        abortRemaining = true;
        // Still allow stopBot to proceed (safer to stop the old bot even if close failed)
        // But skip startBot/startDeal to prevent position conflict
      }
      // Skip the normal delay — verification already includes waiting time
      continue;
    }

    // Apply delay AFTER the action (gives Binance time to process)
    const delayMs = DELAYS[actionName] || 1000;
    if (delayMs > 0 && i < actions.length - 1) {
      log(`[${requestId}]   ⏳ Waiting ${delayMs / 1000}s before next action...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  if (abortRemaining) {
    log(`[${requestId}] ⛔ Sequence PARTIALLY completed — startBot/startDeal skipped (deals not confirmed closed)`);

    // Queue for deferred retry (only on first attempt, not on retries to avoid infinite loops)
    if (!isRetry && targetBot) {
      queueDeferredFlip(actions, requestId, targetBot);
    }

    return { completed: false };
  } else {
    log(`[${requestId}] ✅ All ${actions.length} action(s) completed`);
    const completedNames = actions.map(a => a.action).join(' → ');
    const completedBots = actions
      .map(a => BOT_MAP[a.uuid]?.name || a.uuid?.substring(0, 8) || '?')
      .filter((v, i, arr) => arr.indexOf(v) === i);
    sendTelegramAlert(
      `✅ Signal Completed\n\n` +
      `Actions: ${completedNames}\n` +
      `Bot(s): ${completedBots.join(', ')}\n` +
      `Time: ${istTimestamp()}\n` +
      `Request: ${requestId}`
    ).catch(() => {});

    return { completed: true };
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Signal Bot Router',
    status: PAUSED ? 'paused' : 'running',
    paused: PAUSED,
    pausedAt: PAUSED_AT,
    pausedSignals: PAUSED_SIGNALS,
    uptime: Math.floor(process.uptime()) + 's',
    version: '2.3.0',
    strategy: { mode: STRATEGY_MODE, changedAt: STRATEGY_CHANGED_AT, fundingPollerActive: !!FUNDING_POLL_TIMER },
    lastDirections: LAST_DIRECTION,
    activeBots: ACTIVE_BOTS,
    revalidation: { intervalMs: REVAL_INTERVAL, mode: 'fail-closed', checks: 'Gate 2 (4H EMA 9/21)', autoFlip: true, flipCooldownMs: FLIP_COOLDOWN_MS },
    fundingStrategy: fundingStrategy.getConfig(),
    circuitBreaker: { flipThreshold: CB_FLIP_THRESHOLD, windowMs: CB_WINDOW_MS, parkMs: CB_PARK_MS, state: CIRCUIT_BREAKER },
    flipCooldowns: FLIP_COOLDOWN,
    signalGate: signalGate.getConfig(),
    cryptoCompareKey: !!process.env.CRYPTOCOMPARE_API_KEY,
    apiConfigured: gainiumApi.isConfigured(),
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
  });
});

// ── Pause / Resume endpoints (v1.5.0) ───────────────────────────────────
app.get('/pause', (req, res) => {
  if (PAUSED) {
    return res.json({ status: 'already paused', pausedAt: PAUSED_AT, pausedSignals: PAUSED_SIGNALS });
  }
  PAUSED = true;
  PAUSED_AT = new Date().toISOString();
  PAUSED_SIGNALS = 0;
  log('⏸️ SYSTEM PAUSED — signals will be logged but NOT executed');
  sendTelegramAlert(
    `⏸️ System PAUSED\n\n` +
    `All incoming signals will be logged but NOT executed.\n` +
    `Bots will not be started/stopped.\n` +
    `Time: ${istTimestamp()}\n\n` +
    `Resume: GET /resume`
  ).catch(() => {});
  res.json({ status: 'paused', pausedAt: PAUSED_AT });
});

app.get('/resume', (req, res) => {
  if (!PAUSED) {
    return res.json({ status: 'already running' });
  }
  const pauseDuration = Math.floor((Date.now() - new Date(PAUSED_AT).getTime()) / 1000);
  const signalsMissed = PAUSED_SIGNALS;
  PAUSED = false;
  PAUSED_AT = null;
  PAUSED_SIGNALS = 0;
  log(`▶️ SYSTEM RESUMED — was paused for ${pauseDuration}s, ${signalsMissed} signal(s) received while paused`);
  sendTelegramAlert(
    `▶️ System RESUMED\n\n` +
    `Was paused for ${Math.floor(pauseDuration / 60)}m ${pauseDuration % 60}s\n` +
    `Signals received while paused: ${signalsMissed}\n` +
    `Time: ${istTimestamp()}\n\n` +
    `All incoming signals will now be executed normally.`
  ).catch(() => {});
  res.json({ status: 'running', pauseDuration: pauseDuration + 's', signalsMissed });
});

// ── Strategy Toggle Endpoints (v2.2.0) ──────────────────────────────────
// Switch between crossover (TradingView) and funding (Binance polling) signal sources.

app.get('/strategy', (req, res) => {
  res.json({
    mode: STRATEGY_MODE,
    changedAt: STRATEGY_CHANGED_AT,
    fundingPollerActive: !!FUNDING_POLL_TIMER,
    description: STRATEGY_MODE === 'crossover'
      ? 'TradingView EMA crossover alerts → webhook → gate → bots'
      : 'Binance funding rate polling → gate → bots (every 4h)',
  });
});

app.get('/strategy/crossover', (req, res) => {
  if (STRATEGY_MODE === 'crossover') {
    return res.json({ status: 'already on crossover mode' });
  }
  stopFundingPoller();
  STRATEGY_MODE = 'crossover';
  STRATEGY_CHANGED_AT = new Date().toISOString();
  log('🔀 Strategy switched to CROSSOVER (TradingView alerts)');
  sendTelegramAlert(
    `🔀 Strategy → CROSSOVER\n\n` +
    `Signal source: TradingView EMA alerts\n` +
    `Funding poller: stopped\n` +
    `Time: ${istTimestamp()}`
  ).catch(() => {});
  res.json({ status: 'switched to crossover', mode: STRATEGY_MODE });
});

app.get('/strategy/funding', (req, res) => {
  if (STRATEGY_MODE === 'funding') {
    return res.json({ status: 'already on funding mode' });
  }
  STRATEGY_MODE = 'funding';
  STRATEGY_CHANGED_AT = new Date().toISOString();
  startFundingPoller();
  log('🔀 Strategy switched to FUNDING (Binance funding rate polling)');
  sendTelegramAlert(
    `🔀 Strategy → FUNDING\n\n` +
    `Signal source: Binance funding rate (every 4h)\n` +
    `TradingView webhooks: will be ignored\n` +
    `Time: ${istTimestamp()}`
  ).catch(() => {});
  res.json({ status: 'switched to funding', mode: STRATEGY_MODE });
});

// Test endpoint — signal gate test (v1.7.0)
// Returns what the gate would decide for each pair + direction
app.get('/test-gate/:pair', async (req, res) => {
  const pair = req.params.pair.toUpperCase();
  const results = {};

  for (const direction of ['LONG', 'SHORT']) {
    try {
      results[direction] = await signalGate.validateSignal(pair, direction);
    } catch (err) {
      results[direction] = { error: err.message };
    }
  }

  res.json({
    pair,
    timestamp: istTimestamp(),
    gateConfig: signalGate.getConfig(),
    results,
  });
});

// ── Funding Rate Strategy — status and test endpoints ────────────────────
// Strategy is on STANDBY — these endpoints show what it WOULD do, not trigger trades.

app.get('/funding-status', async (req, res) => {
  try {
    const results = await fundingStrategy.checkAllPairs();
    res.json({
      timestamp: istTimestamp(),
      strategy: fundingStrategy.getConfig(),
      pairs: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/funding-check/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    // Accept both 'SOL' and 'SOLUSDT'
    const fullSymbol = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
    const result = await fundingStrategy.checkPair(fullSymbol);
    res.json({
      timestamp: istTimestamp(),
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test endpoint — end-to-end verification test (calls actual gainium-api functions)
app.get('/test-verify/:uuid', async (req, res) => {
  const uuid = req.params.uuid;
  const bot = BOT_MAP[uuid];
  if (!bot) return res.status(404).json({ error: 'UUID not in BOT_MAP', uuid });

  const results = {};

  // Test 1: getBotDeals (V1 — lists all bots, finds ours by UUID)
  try {
    const deals = await gainiumApi.getBotDeals(uuid);
    results.getBotDeals = deals ? { success: true, deals } : { success: false, error: 'returned null' };
  } catch (e) {
    results.getBotDeals = { success: false, error: e.message };
  }

  // Test 2: listOpenDeals (V1 — lists all deals, filters by mongoId since deals use ObjectId not UUID)
  try {
    const openDeals = await gainiumApi.listOpenDeals(bot.mongoId);
    results.listOpenDeals = { success: true, count: openDeals.length, deals: openDeals.map(d => ({ _id: d._id, pair: d.pair, status: d.status })) };
  } catch (e) {
    results.listOpenDeals = { success: false, error: e.message };
  }

  // Test 3: API configured check
  results.apiConfigured = gainiumApi.isConfigured();

  res.json({
    bot: bot.name,
    uuid,
    mongoId: bot.mongoId,
    apiConfigured: results.apiConfigured,
    getBotDeals: results.getBotDeals,
    listOpenDeals: results.listOpenDeals,
    timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
  });
});

// Main webhook endpoint — TradingView sends alerts here
app.post('/webhook', (req, res) => {
  // Generate a short request ID for log correlation
  const requestId = Math.random().toString(36).substring(2, 8);

  // Respond immediately — TradingView times out after 3 seconds
  res.status(200).json({ received: true, requestId });

  // Extract and validate actions
  const actions = extractActions(req.body);

  if (!actions || actions.length === 0) {
    log(`[${requestId}] ⚠ No valid actions found in body`);
    log(`[${requestId}]   Raw body (first 200 chars): ${String(req.body).substring(0, 200)}`);
    return;
  }

  // Log what we received
  const summary = actions.map(a => `${a.action}(${(a.uuid || '').substring(0, 8)})`).join(' → ');
  log(`[${requestId}] 📨 Received: ${summary}`);

  // ── Strategy mode check — ignore TradingView webhooks when in funding mode ──
  if (STRATEGY_MODE === 'funding') {
    log(`[${requestId}] 🔀 FUNDING MODE — TradingView webhook ignored (signal logged only)`);
    return;
  }

  // Build a human-readable description for Telegram
  const botNames = actions
    .map(a => BOT_MAP[a.uuid]?.name || a.uuid?.substring(0, 8) || '?')
    .filter((v, i, arr) => arr.indexOf(v) === i); // dedupe
  const actionNames = actions.map(a => a.action).join(' → ');

  // ── v1.5.0: Pause mode — log but don't execute ──────────────────────
  if (PAUSED) {
    PAUSED_SIGNALS++;
    log(`[${requestId}] ⏸️ PAUSED — signal logged but NOT executed: ${summary}`);
    sendTelegramAlert(
      `⏸️ Signal Received (PAUSED — not executed)\n\n` +
      `Actions: ${actionNames}\n` +
      `Bot(s): ${botNames.join(', ')}\n` +
      `Time: ${istTimestamp()}\n` +
      `Request: ${requestId}\n\n` +
      `Signal #${PAUSED_SIGNALS} since pause. Resume: GET /resume`
    ).catch(() => {});
    return;
  }

  // ── v1.5.1: Rising-edge detection — suppress duplicate direction ────
  const signal = detectSignalDirection(actions);
  if (signal) {
    const { pair, direction, botName } = signal;
    if (LAST_DIRECTION[pair] === direction) {
      log(`[${requestId}] 🔇 DUPLICATE suppressed — ${pair} already ${direction} (last dispatched). Dropping signal.`);
      sendTelegramAlert(
        `🔇 Duplicate Signal Suppressed\n\n` +
        `${pair}: already ${direction}\n` +
        `Bot: ${botName}\n` +
        `Actions: ${actionNames}\n` +
        `Time: ${istTimestamp()}\n` +
        `Request: ${requestId}\n\n` +
        `This is the same direction we last dispatched. No action taken.`
      ).catch(() => {});
      return;
    }
    // Valid new direction — update tracking BEFORE dispatch
    LAST_DIRECTION[pair] = direction;
    log(`[${requestId}] 📊 Rising-edge: ${pair} direction change → ${direction}`);

    // ── v1.9.0: Circuit breaker — block parked pairs ──────────────────
    const cbCheck = checkCircuitBreaker(pair);
    if (cbCheck.parked) {
      // Revert LAST_DIRECTION since we're not dispatching
      delete LAST_DIRECTION[pair];
      log(`[${requestId}] ⚡ CIRCUIT BREAKER — ${pair} is parked: ${cbCheck.reason}`);
      sendTelegramAlert(
        `⚡ Signal Blocked (Circuit Breaker)\n\n` +
        `${pair} ${direction} → PARKED\n` +
        `Reason: ${cbCheck.reason}\n` +
        `Bot: ${botName}\n` +
        `Time: ${istTimestamp()}\n` +
        `Request: ${requestId}\n\n` +
        `TradingView signal dropped. Pair will resume when park expires.`
      ).catch(() => {});
      return;
    }

    // Record this TradingView flip for circuit breaker tracking
    recordFlip(pair);
  }

  // ── v1.7.0: Signal gate — trend + short-term EMA + RSI + RSI direction ──
  // Only runs for crossover flips (where we detected a direction).
  // Fetches candles from Binance, checks trend alignment + momentum.
  if (signal) {
    const { pair, direction, botName } = signal;
    signalGate.validateSignal(pair, direction).then(gateResult => {
      if (!gateResult.allowed) {
        // Revert the LAST_DIRECTION since we're not dispatching
        delete LAST_DIRECTION[pair];
        log(`[${requestId}] 🚫 SIGNAL GATED — ${gateResult.reason}`);
        sendTelegramAlert(
          `🚫 Signal Gated (not executed)\n\n` +
          `${pair} ${direction} → BLOCKED\n` +
          `Reason: ${gateResult.reason}\n` +
          `Price: $${gateResult.data.currentPrice?.toFixed(2) || '?'}\n` +
          `EMA50: $${gateResult.data.ema50?.toFixed(2) || '?'} (${gateResult.data.priceVsEma || '?'})\n` +
          `RSI(14): ${gateResult.data.rsi14 || '?'}\n` +
          `Time: ${istTimestamp()}\n` +
          `Request: ${requestId}`
        ).catch(() => {});
        return;
      }

      // Gate passed — proceed with dispatch
      log(`[${requestId}] ✅ Gate passed: ${gateResult.reason}`);
      const telegramSummary = `📨 Signal Received (gate passed)\n\n` +
        `Actions: ${actionNames}\n` +
        `Bot(s): ${botNames.join(', ')}\n` +
        `Price: $${gateResult.data.currentPrice?.toFixed(2) || '?'} ${gateResult.data.priceVsEma || ''} EMA50\n` +
        `4H Trend: ${gateResult.data.shortTermTrend || '?'}\n` +
        `RSI(14): ${gateResult.data.rsi14 || '?'} ${gateResult.data.rsiDirection || ''}\n` +
        `Time: ${istTimestamp()}\n` +
        `Request: ${requestId}`;
      sendTelegramAlert(telegramSummary).catch(() => {});

      // Track the started bot for periodic re-validation
      const startAction = actions.find(a => a.action === 'startBot');
      if (startAction && startAction.uuid) {
        ACTIVE_BOTS[startAction.uuid] = {
          pair: signal.pair,
          direction: signal.direction,
          botName: signal.botName,
          startedAt: new Date().toISOString(),
        };
        log(`[${requestId}] 📋 Tracking active bot: ${signal.botName} (${signal.pair} ${signal.direction})`);
      }
      // Clear any stopped bots from tracking
      const stopAction = actions.find(a => a.action === 'stopBot');
      if (stopAction && stopAction.uuid) {
        delete ACTIVE_BOTS[stopAction.uuid];
      }

      processActions(actions, requestId).catch(err => {
        log(`[${requestId}] ❌ Unexpected error: ${err.message}`);
      });
    }).catch(err => {
      // Gate failed to run — let signal through (fail-open)
      log(`[${requestId}] ⚠ Gate error (passing through): ${err.message}`);
      processActions(actions, requestId).catch(err2 => {
        log(`[${requestId}] ❌ Unexpected error: ${err2.message}`);
      });
    });
    return;
  }

  // Non-crossover signals (no startBot action) — pass through without gating
  const telegramSummary = `📨 Signal Received\n\n` +
    `Actions: ${actionNames}\n` +
    `Bot(s): ${botNames.join(', ')}\n` +
    `Time: ${istTimestamp()}\n` +
    `Request: ${requestId}`;
  sendTelegramAlert(telegramSummary).catch(() => {});

  // Process in background (don't block the response)
  processActions(actions, requestId).catch(err => {
    log(`[${requestId}] ❌ Unexpected error: ${err.message}`);
  });
});

// ── Periodic Re-validation (v1.7.1) ─────────────────────────────────────
// Every 2 minutes, re-check all running bots against Gate 2 (4H EMA 9/21)
// and Gate 4 (RSI direction). If conditions have changed, stop the bot.
// FAIL-CLOSED: If data fetch fails, stop the bot.
const REVAL_INTERVAL = 2 * 60 * 1000; // 2 minutes
let revalRunning = false;

async function runRevalidation() {
  if (revalRunning) return; // prevent overlapping runs
  revalRunning = true;

  const activeUUIDs = Object.keys(ACTIVE_BOTS);
  if (activeUUIDs.length === 0) {
    revalRunning = false;
    return;
  }

  for (const uuid of activeUUIDs) {
    const bot = ACTIVE_BOTS[uuid];
    if (!bot) continue;

    try {
      const result = await signalGate.revalidateSignal(bot.pair, bot.direction);

      if (result.allowed) {
        log(`🔄 Reval OK: ${bot.botName} (${bot.pair} ${bot.direction}) — ${result.reason}`);
      } else {
        // Conditions changed — stop the bot
        log(`🔄 Reval FAILED: ${bot.botName} — ${result.reason}`);

        // Send closeAllDeals + stopBot via webhook
        const closePayload = JSON.stringify([
          { action: 'closeAllDeals', uuid },
          { action: 'stopBot', uuid },
        ]);
        try {
          await fetch(GAINIUM_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: closePayload,
          });
          log(`🔄 Reval: Sent closeAllDeals + stopBot for ${bot.botName}`);
        } catch (webhookErr) {
          log(`🔄 Reval: Webhook failed for ${bot.botName}: ${webhookErr.message}`);
        }

        // Remove from active tracking
        delete ACTIVE_BOTS[uuid];
        // Clear rising-edge so next signal for this pair is treated as fresh
        delete LAST_DIRECTION[bot.pair];

        // Record this stop as a flip event for circuit breaker tracking
        recordFlip(bot.pair);

        // ── v1.9.0: Check circuit breaker BEFORE attempting auto-flip ──
        const cbCheck = checkCircuitBreaker(bot.pair);
        if (cbCheck.parked && cbCheck.tripped) {
          // Circuit breaker just tripped — stop any active bot on this pair and park
          log(`🔄 ⚡ CIRCUIT BREAKER TRIPPED: ${bot.pair} — ${cbCheck.reason}`);
          sendTelegramAlert(
            `⚡ CIRCUIT BREAKER: ${bot.pair} parked for 30 min\n\n` +
            `Reason: ${cbCheck.reason}\n` +
            `Market is choppy — no trades on ${bot.pair} until ${CIRCUIT_BREAKER[bot.pair].parkedUntil}\n` +
            `Other pairs continue normally.\n` +
            `Time: ${istTimestamp()}`
          ).catch(() => {});
          // Skip auto-flip entirely
        } else if (cbCheck.parked) {
          // Already parked from earlier trip
          log(`🔄 ⚡ ${bot.pair} still parked (circuit breaker) — skipping auto-flip`);
        } else {
          // ── v1.8.0 + v1.9.0: Auto-flip with cooldown ──────────────
          const oppositeDir = bot.direction === 'LONG' ? 'SHORT' : 'LONG';
          const oppositeBot = findOppositeBot(bot.pair, bot.direction);
          let flipResult = null;

          if (!oppositeBot) {
            flipResult = { flipped: false, reason: `No opposite bot found for ${bot.pair}` };
          } else if (isFlipOnCooldown(bot.pair)) {
            const cooldownRemain = Math.ceil((FLIP_COOLDOWN_MS - (Date.now() - new Date(FLIP_COOLDOWN[bot.pair]).getTime())) / 1000);
            log(`🔄 Auto-flip: ${bot.pair} on cooldown (${cooldownRemain}s remaining) — skipping`);
            flipResult = { flipped: false, reason: `Flip cooldown active (${cooldownRemain}s remaining)` };
          } else {
            log(`🔄 Auto-flip: checking ${bot.pair} ${oppositeDir} through full 4-gate validation...`);
            try {
              const gateResult = await signalGate.validateSignal(bot.pair, oppositeDir);
              if (gateResult.allowed) {
                log(`🔄 Auto-flip: ${oppositeBot.name} PASSED all gates — starting`);
                try {
                  await fetch(GAINIUM_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify([{ action: 'startBot', uuid: oppositeBot.uuid }]),
                  });
                  ACTIVE_BOTS[oppositeBot.uuid] = {
                    pair: bot.pair,
                    direction: oppositeDir,
                    botName: oppositeBot.name,
                    startedAt: new Date().toISOString(),
                  };
                  LAST_DIRECTION[bot.pair] = oppositeDir;
                  // Set cooldown — no further auto-flips on this pair for 10 min
                  FLIP_COOLDOWN[bot.pair] = new Date().toISOString();
                  // Record the flip for circuit breaker
                  recordFlip(bot.pair);
                  flipResult = { flipped: true, botName: oppositeBot.name, gateData: gateResult.data };
                  log(`🔄 Auto-flip: ${oppositeBot.name} started and tracked (cooldown set)`);
                } catch (flipErr) {
                  log(`🔄 Auto-flip: webhook failed for ${oppositeBot.name}: ${flipErr.message}`);
                  flipResult = { flipped: false, reason: `Webhook failed: ${flipErr.message}` };
                }
              } else {
                log(`🔄 Auto-flip: ${bot.pair} ${oppositeDir} BLOCKED — ${gateResult.reason}`);
                flipResult = { flipped: false, reason: gateResult.reason };
              }
            } catch (gateErr) {
              log(`🔄 Auto-flip: gate error for ${bot.pair} ${oppositeDir}: ${gateErr.message}`);
              flipResult = { flipped: false, reason: `Gate error: ${gateErr.message}` };
            }
          }

          // Alert to Telegram (includes flip result)
          let alertMsg = `🔄 REVALIDATION STOP\n\n` +
            `Bot: ${bot.botName}\n` +
            `Reason: ${result.reason}\n` +
            `Data: 4H trend ${result.data.shortTermTrend || '?'}, RSI ${result.data.rsi14 || '?'} ${result.data.rsiDirection || ''}\n` +
            `Started: ${bot.startedAt}\n` +
            `Stopped: ${new Date().toISOString()}`;

          if (flipResult && flipResult.flipped) {
            alertMsg += `\n\n↔️ AUTO-FLIP: Started ${flipResult.botName}\n` +
              `Price: $${flipResult.gateData.currentPrice?.toFixed(2) || '?'}\n` +
              `4H Trend: ${flipResult.gateData.shortTermTrend || '?'}\n` +
              `RSI: ${flipResult.gateData.rsi14 || '?'} ${flipResult.gateData.rsiDirection || ''}`;
          } else if (flipResult) {
            alertMsg += `\n\n⏸️ No flip: ${flipResult.reason}`;
          }

          sendTelegramAlert(alertMsg).catch(() => {});
        }
      }
    } catch (err) {
      log(`🔄 Reval error for ${bot.botName}: ${err.message}`);
    }
  }

  revalRunning = false;
}

// Start the re-validation interval
setInterval(runRevalidation, REVAL_INTERVAL);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`🚀 Signal Bot Router v2.2.0 listening on port ${PORT}`);
  log(`   Webhook endpoint: POST /webhook`);
  log(`   Health check: GET /`);
  log(`   Gainium target: ${GAINIUM_WEBHOOK_URL}`);
  log(`   API verification: ${gainiumApi.isConfigured() ? '✅ configured' : '⚠ NOT configured (set GAINIUM_API_KEY + GAINIUM_API_SECRET)'}`);
  log(`   Telegram alerts: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? '✅ configured' : '⚠ NOT configured (optional)'}`);
  log(`   Periodic re-validation: every ${REVAL_INTERVAL / 1000}s (fail-closed)`);
  log(`   Known bots: ${Object.keys(BOT_MAP).length}`);
});
