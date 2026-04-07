const express = require('express');
const app = express();
const gainiumApi = require('./gainium-api');
const binanceApi = require('./binance-api');
const signalGate = require('./signal-gate');
const fundingStrategy = require('./funding-strategy');
const tradeJournal = require('./trade-journal');

// Parse both JSON and plain text bodies (TradingView sends text/plain when message has emoji prefix)
app.use(express.json());
app.use(express.text({ type: '*/*' }));

const VERSION = '3.8.3';
const GAINIUM_WEBHOOK_URL = 'https://api.gainium.io/trade_signal';

// ── UUID → MongoDB ID mapping (for API verification) ────────────────────
// The relay needs MongoDB ObjectIds to call get_bot / manage_deal.
// UUID is what TradingView sends; Mongo ID is what the Gainium REST API uses.
// V3.1 bots — startCondition: ASAP, gated by relay webhook start/stop
// TechnicalIndicators tested 2-4 Apr 2026 but Gainium never evaluated them.
// ASAP + 5-min cooldown + 2-min revalidation = controlled re-entry without churning.
const BOT_MAP = {
  '61a66c9f-7463-46db-a72f-2ef39565bc20': { mongoId: '69ce1dc4228af151def7f93e', name: 'SOL Long v2' },
  '3af77f4f-73a7-45c1-a0fd-b7c3ce9f16ee': { mongoId: '69ce1dc6228af151def7f97b', name: 'SOL Short v2' },
  '4d6f6265-4c9a-42e7-bf85-8956a1c03f6c': { mongoId: '69ce1dc8228af151def7f9a0', name: 'ETH Long v2' },
  '69c91263-68c9-4f88-a543-7c319b5fde8b': { mongoId: '69ce1dca228af151def7fa03', name: 'ETH Short v2' },
  'eb74f76c-c6ec-48c2-a74d-d9fd27c2fab5': { mongoId: '69ce1dcc228af151def7fa3c', name: 'XRP Long v2' },
  '2751574b-cc46-4f62-bd01-cb404c21f8d7': { mongoId: '69ce1dcd228af151def7fab8', name: 'XRP Short v2' },
  'd0ea54dc-7218-4666-8c81-85bcd0271a3f': { mongoId: '69ce1dcf228af151def7faf7', name: 'BTC Long v2' },
  '21c9985a-db38-440d-9313-ac13825852be': { mongoId: '69ce1dd1228af151def7fb2e', name: 'BTC Short v2' },
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
    // Try HTML parse mode first (supports <b>, <i>, etc. in hand-crafted alerts)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      // HTML parse failed (likely unescaped < or > in gate reason strings).
      // Retry as plain text — lose bold/italic but the message gets delivered.
      log(`⚠ Telegram HTML send failed (${body.description || res.status}), retrying as plain text`);
      const res2 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
        }),
      });
      const body2 = await res2.json().catch(() => ({}));
      if (!body2.ok) {
        log(`❌ Telegram plain-text send also failed: ${body2.description || res2.status}`);
      }
    }
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
// Key = UUID, Value = { pair, direction, botName, startedAt, origin }
// Only populated when the relay dispatches a startBot action.
// origin: 'signal' (TradingView), 'auto-flip' (reval), 'funding', 'self-heal'
const ACTIVE_BOTS = {};

// ── Pair Activity Tracker (v3.2.8) ─────────────────────────────────────
// Records when each pair last had an active bot (any origin).
// Used by self-heal to distinguish orphaned pairs from intentionally flat ones.
// Key = pair name (e.g. 'SOL'), Value = timestamp (ms)
const LAST_ACTIVE = {};

// ── Self-Heal Cooldown (v3.2.8) ────────────────────────────────────────
// Max one self-heal restart per pair per 30 minutes.
// Prevents silent churn if gate keeps flip-flopping on an orphaned pair.
// Key = pair name, Value = timestamp (ms) of last self-heal restart
const SELF_HEAL_COOLDOWNS = {};
const SELF_HEAL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes (circuit breaker handles real churn)
const SELF_HEAL_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours — only recover pairs active within this window

// ── Cold-Start Mode (v3.8.0) ─────────────────────────────────────────────
// On fresh startup with no active positions, self-heal skips all pairs because
// LAST_ACTIVE is empty ("never started by this relay instance"). Cold-start mode
// bypasses that check on the FIRST self-heal run so the system can detect the
// existing market trend and enter positions without waiting for a TradingView
// crossover that may have already happened before the alerts were created.
// Set to true on boot, cleared after the first self-heal cycle completes.
let COLD_START_MODE = true;

// ── Telegram Alert Cooldown (v3.1.1) ──────────────────────────────────
// Prevents spamming the same alert type per bot. Tracks last send time.
// Key = `${uuid}:${alertType}`, Value = timestamp (ms)
const TELEGRAM_COOLDOWNS = {};
const TELEGRAM_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between same alert per bot

function canSendTelegramAlert(uuid, alertType) {
  const key = `${uuid}:${alertType}`;
  const last = TELEGRAM_COOLDOWNS[key];
  if (!last) return true;
  return (Date.now() - last) >= TELEGRAM_COOLDOWN_MS;
}

function markTelegramAlertSent(uuid, alertType) {
  TELEGRAM_COOLDOWNS[`${uuid}:${alertType}`] = Date.now();
}

// ── Rising-Edge Detection (v1.5.1) ─────────────────────────────────────
// Tracks the last dispatched direction per trading pair.
// If a signal wants to flip to the SAME direction we already dispatched,
// it's a duplicate (sustained crossover state, not a new transition) — drop it.
//
// Key = pair name (e.g. 'SOLUSDT'), Value = 'LONG' | 'SHORT' | null
const LAST_DIRECTION = {};

// ── Gate Pending Lock (v3.6.0) ─────────────────────────────────────────
// Prevents duplicate concurrent gate checks on the same pair.
// Set when a gate check starts, cleared when it completes (pass or fail).
// Key = pair name, Value = { direction, timestamp }
const GATE_PENDING = {};

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

// ── Recovery Lock (v3.5.2) ────────────────────────────────────────────
// After startup recovery, lock recovered pairs for 3 minutes so incoming
// TradingView signals don't try to flip ghost positions (stale Gainium deals
// that no longer have a matching Binance position). Revalidation runs every
// 2 min and handles cleanup — the lock prevents an alert cascade from
// signals arriving during recovery before reval has had a chance to verify.
// Key = pair name, Value = unlock timestamp (ms)
const RECOVERY_LOCK = {};
const RECOVERY_LOCK_MS = 3 * 60 * 1000; // 3 minutes

function isRecoveryLocked(pair) {
  const unlockAt = RECOVERY_LOCK[pair];
  if (!unlockAt) return false;
  if (Date.now() >= unlockAt) {
    delete RECOVERY_LOCK[pair];
    return false;
  }
  return true;
}

// ── Circuit Breaker (v1.9.0, tightened v3.7.0) ───────────────────────────────────────────
// v3.7.0: Tightened from 3 to 2 flips. 1H signals generate more crossovers
// in chop — the circuit breaker needs to be more sensitive to prevent
// rapid flip-flopping on the faster timeframe.
// Key = pair name, Value = { flips: [timestamps], parkedUntil: ISO | null }
const CIRCUIT_BREAKER = {};
const CB_FLIP_THRESHOLD = 2;    // v3.7.0: was 3 — tighter for 1H signals
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
          `🚫 Funding signal blocked\n\n` +
          `Tried to open a ${direction} on ${pair} because the funding rate (${result.data.fundingPct}) favours it, but the safety checks didn't pass.\n\n` +
          `Why: ${gateResult.reason}\n` +
          `No trade was placed.\n\n` +
          `${istTimestamp()}`
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

      // v3.6.0: Set LAST_DIRECTION after dispatch confirmation (consistent with
      // webhook handler). Previously set before processActions — if processActions
      // aborted, LAST_DIRECTION was stale until the next signal corrected it.
      recordFlip(pair);
      fundingStrategy.recordSignal(result.data.symbol, direction);

      // Track active bot for revalidation
      ACTIVE_BOTS[targetBot.uuid] = {
        pair,
        direction,
        botName: targetBot.name,
        startedAt: new Date().toISOString(),
        entryPrice: result.data.markPrice || null,
        origin: 'funding',
      };
      LAST_ACTIVE[pair] = Date.now();
      // v3.6.0: Don't delete old bot from tracking until processActions confirms
      // the close succeeded — same pattern as the webhook handler fix in v3.5.0.
      const oldFundingUuid = oppositeBot?.uuid;

      // Send Telegram notification
      sendTelegramAlert(
        `📊 Funding rate trade\n\n` +
        `Opening a ${direction} on ${pair} at $${result.data.markPrice?.toFixed(2) || '?'}.\n\n` +
        `The funding rate (${result.data.fundingPct}) suggests traders are leaning the other way, which creates an opportunity. All safety checks passed.\n\n` +
        `${istTimestamp()}`
      ).catch(() => {});

      // Execute through the same pipeline
      log(`[${requestId}] [FUNDING] Dispatching: ${actions.map(a => `${a.action}(${a.uuid.substring(0, 8)})`).join(' → ')}`);
      const fundingContext = { pair, direction, price: result.data.markPrice?.toFixed(2) };
      processActions(actions, requestId, false, fundingContext).then(pResult => {
        if (pResult?.completed) {
          // v3.6.0: Set LAST_DIRECTION only after confirmed dispatch
          LAST_DIRECTION[pair] = direction;
          // v3.6.0: Journal
          if (oldFundingUuid) {
            tradeJournal.recordExit({ botUuid: oldFundingUuid, exitPrice: result.data.markPrice, exitReason: 'funding-flip' });
            delete ACTIVE_BOTS[oldFundingUuid];
            log(`[${requestId}] [FUNDING] 📋 Removed old bot ${oldFundingUuid.substring(0, 8)} from tracking (close verified)`);
          }
          tradeJournal.recordEntry({ pair, direction, botName: targetBot.name, botUuid: targetBot.uuid, entryPrice: result.data.markPrice, origin: 'funding', gateData: gateResult.data });
        } else {
          if (oldFundingUuid && ACTIVE_BOTS[oldFundingUuid]) {
            log(`[${requestId}] [FUNDING] ⚠ Close may have failed — keeping ${ACTIVE_BOTS[oldFundingUuid]?.botName} in ACTIVE_BOTS for safety`);
          }
        }
      }).catch(err => {
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

function queueDeferredFlip(actions, requestId, targetBot, context = {}) {
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
    context,
    queuedAt: Date.now(),
    retryCount: 0,
  });

  log(`[${requestId}] 📋 Queued deferred flip for ${targetBot.name} — will retry every 60s for up to 5 min`);
  sendTelegramAlert(
    `📋 Waiting to switch direction\n\n` +
    `Trying to start ${targetBot.name}, but Binance still has the old position open (a "position conflict"). Will keep retrying every 60 seconds for up to 5 minutes while it clears.\n\n` +
    `${istTimestamp()}`
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
      const result = await processActions(item.actions, item.requestId + `-r${item.retryCount}`, true, item.context || {});

      if (result && result.completed) {
        log(`[${item.requestId}] ✅ Deferred flip SUCCEEDED for ${item.targetBot.name} on retry ${item.retryCount}`);
        // v3.6.0: Clean up old bot from ACTIVE_BOTS. The original webhook handler's
        // .then() saw completed=false (abort) and didn't delete. The deferred retry
        // succeeded, so the old bot's deals are now verified closed.
        if (item.targetBot.uuid && ACTIVE_BOTS[item.targetBot.uuid]) {
          log(`[${item.requestId}] 📋 Removing old bot ${item.targetBot.name} from ACTIVE_BOTS (deferred close verified)`);
          delete ACTIVE_BOTS[item.targetBot.uuid];
        }
        // v3.6.0: Identify the NEW bot from the startBot action (item.targetBot is the OLD bot being closed)
        const startAction = item.actions.find(a => a.action === 'startBot');
        const newBotName = startAction ? (BOT_MAP[startAction.uuid]?.name || 'new bot') : 'new bot';
        sendTelegramAlert(
          `✅ Direction switch succeeded\n\n` +
          `${newBotName} is now running. The old position (${item.targetBot.name}) cleared and the new bot started after ${item.retryCount} retries.\n\n` +
          `${istTimestamp()}`
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
        `❌ Direction switch failed\n\n` +
        `Couldn't start ${item.targetBot.name} after 5 minutes of retrying. The old position on Binance didn't close in time.\n\n` +
        `⚠️ Check Gainium manually — you may need to close the stuck position and restart the bot.\n\n` +
        `${istTimestamp()}`
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
  startBot:      0,     // No delay needed — ASAP opens deal on its own
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
  const alertMsg = `🚨 Trade switch cancelled — ${targetBot.name}\n\n` +
    `${result.error}\n\n` +
    `The system tried to switch direction but couldn't verify the old position closed properly on Binance. To be safe, the new bot was NOT started — this avoids having two opposite positions open at once (a "position conflict").\n\n` +
    `⚠️ Check Gainium/Binance manually.\n\n` +
    `${istTimestamp()}`;
  log(`[${requestId}]   🚨 ${alertMsg}`);
  await sendTelegramAlert(alertMsg);

  return { verified: false, abortRemaining: true };
}

// ── Process actions sequentially with delays ─────────────────────────────

async function processActions(actions, requestId, isRetry = false, context = {}) {
  // v3.1.1: Bots use startCondition=ASAP, controlled by relay webhook start/stop.
  // Webhook startBot activates the bot; ASAP opens a deal immediately.
  // After TP/SL, ASAP re-enters after 5-min cooldown (Gainium-side).
  // Relay safety layers prevent churning:
  //   - 5-min cooldown between deals (Gainium-side, longer than 2-min reval)
  //   - 2-min revalidation with 4% drawdown kill (relay-side)
  //   - Bot stopped if external gates fail while deal is closed (pre-re-entry)

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
      queueDeferredFlip(actions, requestId, targetBot, context);
    }

    return { completed: false };
  } else {
    log(`[${requestId}] ✅ All ${actions.length} action(s) completed`);
    const completedBots = actions
      .map(a => BOT_MAP[a.uuid]?.name || a.uuid?.substring(0, 8) || '?')
      .filter((v, i, arr) => arr.indexOf(v) === i);

    // Build plain-English completion message with technical context in brackets
    const hasClose = actions.some(a => a.action === 'closeAllDeals');
    const hasStart = actions.some(a => a.action === 'startBot');
    const { pair, direction, price, isNoOp } = context;

    let tradeMsg;
    if (isNoOp && pair) {
      // No-op: bot was already running in this direction, nothing changed on Binance
      tradeMsg = `ℹ️ Already in position — no change\n\n` +
        `${pair} is already ${direction}. TradingView sent a repeat signal, and all API calls succeeded, but no new orders were placed on Binance.\n\n` +
        `Your existing position continues as-is.\n` +
        `${istTimestamp()}`;
    } else if (hasClose && hasStart && pair) {
      // Crossover flip: closed old position, opened new one
      tradeMsg = `✅ Trade switch complete\n\n` +
        `Closed the previous ${pair} position and opened a new ${direction} at $${price || '?'}.\n` +
        `(closeAllDeals → stopBot → startBot)\n\n` +
        `Bot: ${completedBots.join(', ')}\n` +
        `${istTimestamp()}`;
    } else if (hasStart && pair) {
      // Fresh entry, no close needed
      tradeMsg = `✅ Trade opened\n\n` +
        `Opened a ${direction} on ${pair} at $${price || '?'}.\n` +
        `(startBot)\n\n` +
        `Bot: ${completedBots.join(', ')}\n` +
        `${istTimestamp()}`;
    } else {
      // Fallback for non-crossover signals (stopBot only, etc.)
      const completedNames = actions.map(a => a.action).join(' → ');
      tradeMsg = `✅ Action complete\n\n` +
        `Done: ${completedNames}\n` +
        `Bot: ${completedBots.join(', ')}\n` +
        `${istTimestamp()}`;
    }
    sendTelegramAlert(tradeMsg).catch(() => {});

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
    version: VERSION,
    strategy: { mode: STRATEGY_MODE, changedAt: STRATEGY_CHANGED_AT, fundingPollerActive: !!FUNDING_POLL_TIMER },
    lastDirections: LAST_DIRECTION,
    activeBots: ACTIVE_BOTS,
    revalidation: { intervalMs: REVAL_INTERVAL, mode: 'fail-closed', checks: 'Gate 1 (daily EMA50 — ADVISORY) + Gate 2 (1H EMA 9/21) + Gate 3 (1H RSI 35/65) + price drawdown + gated re-entry', maxDrawdownPct: REVAL_MAX_DRAWDOWN_PCT, autoFlip: true, flipCooldownMs: FLIP_COOLDOWN_MS, minEmaSpreadPct: signalGate.CONFIG.shortTermEma.minRevalSpreadPct, profitShieldPct: REVAL_PROFIT_SHIELD_PCT, gracePeriodMs: REVAL_GRACE_PERIOD_MS, maxUnderwaterMs: REVAL_MAX_UNDERWATER_MS },
    fundingStrategy: fundingStrategy.getConfig(),
    circuitBreaker: { flipThreshold: CB_FLIP_THRESHOLD, windowMs: CB_WINDOW_MS, parkMs: CB_PARK_MS, state: CIRCUIT_BREAKER },
    flipCooldowns: FLIP_COOLDOWN,
    recoveryLocks: RECOVERY_LOCK,
    gatePending: GATE_PENDING,
    signalGate: signalGate.getConfig(),
    journal: tradeJournal.getSessionStats(),
    whaleHealth: tradeJournal.getWhaleWalletStatus(),
    cryptoCompareKey: !!process.env.CRYPTOCOMPARE_API_KEY,
    apiConfigured: gainiumApi.isConfigured(),
    exchangeDataSource: 'gainium',
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
    `⏸️ System paused\n\n` +
    `The relay is on hold. Any signals from TradingView will be logged but no trades will be placed until you resume.\n\n` +
    `${istTimestamp()}`
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
    `▶️ System resumed\n\n` +
    `Back online after ${Math.floor(pauseDuration / 60)}m ${pauseDuration % 60}s. ${signalsMissed > 0 ? `${signalsMissed} signal(s) came in while paused and were skipped.` : 'No signals were missed.'} Trading is active again.\n\n` +
    `${istTimestamp()}`
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
    `🔀 Switched to crossover mode\n\n` +
    `Now using TradingView moving average alerts (EMA crossovers) to decide trades. Funding rate polling is off.\n\n` +
    `${istTimestamp()}`
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
    `🔀 Switched to funding rate mode\n\n` +
    `Now using Binance funding rates (checked every 4 hours) to decide trades. TradingView crossover alerts will be ignored.\n\n` +
    `${istTimestamp()}`
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

// ── Gate Check Endpoint (v2.3.0) ───────────────────────────────────────
// Quick-check whether a pair+direction would pass or fail the signal gate right now.
// GET /gate-check/SOL/LONG  or  /gate-check/ETH/SHORT
app.get('/gate-check/:pair/:direction', async (req, res) => {
  try {
    const pair = req.params.pair.toUpperCase();
    const direction = req.params.direction.toUpperCase();
    if (!['LONG', 'SHORT'].includes(direction)) {
      return res.status(400).json({ error: 'Direction must be LONG or SHORT' });
    }
    const result = await signalGate.validateSignal(pair, direction);
    res.json({
      timestamp: istTimestamp(),
      pair,
      direction,
      wouldPass: result.allowed,
      reason: result.reason,
      data: result.data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /gate-check — all pairs, both directions at once
app.get('/gate-check', async (req, res) => {
  try {
    const pairs = ['SOL', 'ETH', 'BTC', 'XRP'];
    const results = {};
    for (const pair of pairs) {
      const [longResult, shortResult] = await Promise.all([
        signalGate.validateSignal(pair, 'LONG'),
        signalGate.validateSignal(pair, 'SHORT'),
      ]);
      results[pair] = {
        price: longResult.data.currentPrice || shortResult.data.currentPrice || null,
        LONG: { wouldPass: longResult.allowed, reason: longResult.reason, data: longResult.data },
        SHORT: { wouldPass: shortResult.allowed, reason: shortResult.reason, data: shortResult.data },
      };
    }
    res.json({ timestamp: istTimestamp(), results });
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

  // ── v3.2.9: Bare stopBot/closeAllDeals — clean up ACTIVE_BOTS without signal gate ──
  // When a signal has stopBot but NO startBot, it's a manual close/stop command.
  // Must clear ACTIVE_BOTS directly since the signal-gate path (which requires startBot) won't run.
  const hasStartBot = actions.some(a => a.action === 'startBot');
  const stopActions = actions.filter(a => a.action === 'stopBot');
  if (!hasStartBot && stopActions.length > 0) {
    for (const sa of stopActions) {
      if (sa.uuid && ACTIVE_BOTS[sa.uuid]) {
        const bot = ACTIVE_BOTS[sa.uuid];
        log(`[${requestId}] 🛑 Bare stopBot — removing ${bot.botName} from ACTIVE_BOTS`);
        delete ACTIVE_BOTS[sa.uuid];
        delete LAST_DIRECTION[bot.pair];
      }
    }
    // Forward actions to Gainium (closeAllDeals + stopBot) then return
    processActions(actions, requestId, false, {}).catch(err => {
      log(`[${requestId}] ❌ Bare stopBot error: ${err.message}`);
    });
    return;
  }

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
      `⏸️ Signal received but system is paused\n\n` +
      `TradingView sent a signal for ${botNames.join(', ')}, but the system is paused so no trade was placed. This is signal #${PAUSED_SIGNALS} since the pause.\n\n` +
      `${istTimestamp()}`
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
        `🔇 Duplicate signal ignored\n\n` +
        `TradingView said go ${direction} on ${pair}, but we're already ${direction}. This is a repeat of the last signal — no action needed.\n\n` +
        `${istTimestamp()}`
      ).catch(() => {});
      return;
    }
    // v3.6.0: Gate pending lock — prevent concurrent gate checks for the same pair.
    // Without this, two signals arriving during the async gate window could both
    // pass the duplicate check and dispatch concurrently.
    if (GATE_PENDING[pair]) {
      log(`[${requestId}] 🔇 GATE IN PROGRESS — ${pair} already has a ${GATE_PENDING[pair].direction} gate check running. Dropping signal.`);
      return;
    }
    GATE_PENDING[pair] = { direction, timestamp: Date.now() };
    log(`[${requestId}] 📊 Rising-edge: ${pair} direction change → ${direction}`);

    // ── v3.5.2: Recovery lock — defer signals to reval during startup ──
    if (isRecoveryLocked(pair)) {
      delete GATE_PENDING[pair];
      log(`[${requestId}] 🔒 RECOVERY LOCK — ${pair} was just recovered from restart. Deferring to revalidation for verification.`);
      sendTelegramAlert(
        `🔒 Signal deferred — recovery lock\n\n` +
        `TradingView sent ${direction} on ${pair}, but this pair was just recovered during server restart. ` +
        `Signals are deferred for 3 minutes while revalidation verifies the position is real.\n\n` +
        `${istTimestamp()}`
      ).catch(() => {});
      return;
    }

    // ── v1.9.0: Circuit breaker — block parked pairs ──────────────────
    const cbCheck = checkCircuitBreaker(pair);
    if (cbCheck.parked) {
      delete GATE_PENDING[pair];
      log(`[${requestId}] ⚡ CIRCUIT BREAKER — ${pair} is parked: ${cbCheck.reason}`);
      sendTelegramAlert(
        `⚡ Circuit breaker — ${pair} paused\n\n` +
        `${pair} has been flipping direction too quickly (a sign of a choppy, indecisive market). The "circuit breaker" has kicked in to prevent losses from rapid back-and-forth trading.\n\n` +
        `${pair} is parked for 30 min. Other pairs continue normally.\n\n` +
        `${istTimestamp()}`
      ).catch(() => {});
      return;
    }

    // v3.6.0: recordFlip moved AFTER gate pass — gated signals should not
    // count toward the circuit breaker threshold. Previously at this location,
    // 3 gated signals in 15 min would trip the breaker with zero actual trades.
  }

  // ── v1.7.0: Signal gate — trend + short-term EMA + RSI + RSI direction ──
  // Only runs for crossover flips (where we detected a direction).
  // Fetches candles from Binance, checks trend alignment + momentum.
  if (signal) {
    const { pair, direction, botName } = signal;
    signalGate.validateSignal(pair, direction).then(gateResult => {
      if (!gateResult.allowed) {
        // v3.6.0: Clear gate lock — don't set LAST_DIRECTION since we're not dispatching
        delete GATE_PENDING[pair];
        log(`[${requestId}] 🚫 SIGNAL GATED — ${gateResult.reason}`);
        sendTelegramAlert(
          `🚫 Trade signal rejected\n\n` +
          `Signal: 1H EMA 9/21 crossover\n` +
          `TradingView said go ${direction} on ${pair} at $${gateResult.data.currentPrice?.toFixed(2) || '?'}, but the safety checks ("signal gate") blocked it.\n\n` +
          `Why: ${gateResult.reason}\n` +
          `RSI(14): ${gateResult.data.rsi14 || '?'} · EMA50: $${gateResult.data.ema50?.toFixed(2) || '?'} (price ${gateResult.data.priceVsEma || '?'})\n\n` +
          `No trade placed — waiting for better alignment.\n\n` +
          `${istTimestamp()}`
        ).catch(() => {});
        return;
      }

      // Gate passed — proceed with dispatch
      // v3.6.0: Set LAST_DIRECTION here (after gate success) instead of before
      // the async gate check. Prevents race where a second signal during the
      // gate window gets wrongly suppressed as duplicate.
      LAST_DIRECTION[pair] = direction;
      delete GATE_PENDING[pair];
      // v3.6.0: Record flip AFTER gate pass — only actual dispatches count
      // toward circuit breaker. Previously recorded before gate, causing
      // phantom trips on gated signals.
      recordFlip(pair);
      log(`[${requestId}] ✅ Gate passed: ${gateResult.reason}`);
      const startedBot = botNames.find(n => n !== '?') || '?';
      const telegramSummary = `📨 New trade opening\n\n` +
        `Signal: 1H EMA 9/21 crossover\n` +
        `TradingView crossover alert → going ${direction} on ${pair} at $${gateResult.data.currentPrice?.toFixed(2) || '?'}.\n\n` +
        `✅ 1H trend: ${gateResult.data.shortTermTrend || '?'} (EMA9 vs EMA21 — the short-term moving averages agree)\n` +
        `✅ RSI(14): ${gateResult.data.rsi14 || '?'} ${gateResult.data.rsiDirection || ''} (momentum indicator is in range)\n` +
        `✅ Price is ${gateResult.data.priceVsEma || '?'} the 50-period EMA ($${gateResult.data.ema50?.toFixed(2) || '?'})\n\n` +
        `Bot: ${botNames.join(', ')}\n` +
        `${istTimestamp()}`;
      sendTelegramAlert(telegramSummary).catch(() => {});

      // Detect no-op: if the startBot target is already active in the same direction,
      // the API calls will succeed but nothing changes on Binance.
      const startAction = actions.find(a => a.action === 'startBot');
      let isNoOp = false;
      if (startAction && startAction.uuid) {
        const existing = ACTIVE_BOTS[startAction.uuid];
        if (existing && existing.direction === direction) {
          isNoOp = true;
          log(`[${requestId}] ℹ️ NO-OP: ${signal.botName} is already ${direction} — API calls will succeed but nothing changes on Binance`);
        }
        // Update tracking regardless (refreshes timestamp)
        ACTIVE_BOTS[startAction.uuid] = {
          pair: signal.pair,
          direction: signal.direction,
          botName: signal.botName,
          startedAt: existing?.startedAt || new Date().toISOString(),
          entryPrice: existing?.entryPrice || gateResult.data.currentPrice || null,
          origin: 'signal',
        };
        LAST_ACTIVE[signal.pair] = Date.now();
        log(`[${requestId}] 📋 Tracking active bot: ${signal.botName} (${signal.pair} ${signal.direction}) @ $${gateResult.data.currentPrice?.toFixed(2) || '?'}`);
      }
      // v3.5.0: Don't delete old bot from tracking until processActions confirms
      // the close succeeded. Previously deleted immediately (optimistic) — if
      // closeAllDeals failed, the old position became invisible to revalidation.
      const stopAction = actions.find(a => a.action === 'stopBot');
      const oldBotUuid = stopAction?.uuid;

      const tradeContext = { pair, direction, price: gateResult.data.currentPrice?.toFixed(2), isNoOp };
      processActions(actions, requestId, false, tradeContext).then(result => {
        if (result?.completed) {
          // v3.6.0: Journal — record exit for old bot, entry for new bot
          if (oldBotUuid) {
            tradeJournal.recordExit({ botUuid: oldBotUuid, exitPrice: gateResult.data.currentPrice, exitReason: 'signal-flip' });
            delete ACTIVE_BOTS[oldBotUuid];
            log(`[${requestId}] 📋 Removed old bot ${oldBotUuid.substring(0, 8)} from tracking (close verified)`);
          }
          if (startAction && !isNoOp) {
            tradeJournal.recordEntry({ pair, direction, botName: signal.botName, botUuid: startAction.uuid, entryPrice: gateResult.data.currentPrice, origin: 'signal', gateData: gateResult.data });
          }
        } else if (oldBotUuid && ACTIVE_BOTS[oldBotUuid]) {
          log(`[${requestId}] ⚠ Close may have failed — keeping ${ACTIVE_BOTS[oldBotUuid]?.botName} in ACTIVE_BOTS for safety`);
        }
      }).catch(err => {
        log(`[${requestId}] ❌ Unexpected error: ${err.message}`);
      });
    }).catch(err => {
      // v3.5.0: FAIL-CLOSED — gate error blocks signal (was fail-open).
      // A Binance API hiccup is not a reason to bypass all 5 safety gates.
      delete GATE_PENDING[pair];
      log(`[${requestId}] 🚫 Gate error (BLOCKED — fail-closed): ${err.message}`);
      sendTelegramAlert(
        `🚫 Signal blocked — gate error\n\n` +
        `Signal: 1H EMA 9/21 crossover\n` +
        `TradingView sent ${direction} on ${pair}, but the safety gate couldn't run: ${err.message}\n\n` +
        `Signal was NOT executed. Will wait for next signal when data is available.\n\n` +
        `${istTimestamp()}`
      ).catch(() => {});
    });
    return;
  }

  // Non-crossover signals (no startBot action) — pass through without gating
  const telegramSummary = `📨 Signal received\n\n` +
    `${actionNames} on ${botNames.join(', ')}.\n\n` +
    `${istTimestamp()}`;
  sendTelegramAlert(telegramSummary).catch(() => {});

  // Process in background (don't block the response)
  processActions(actions, requestId).catch(err => {
    log(`[${requestId}] ❌ Unexpected error: ${err.message}`);
  });
});

// ── Periodic Re-validation (v1.7.1) ─────────────────────────────────────
// Every 2 minutes, re-check all running bots against Gate 2 (1H EMA 9/21)
// and Gate 4 (RSI direction). If conditions have changed, stop the bot.
// FAIL-CLOSED: If data fetch fails, stop the bot.
const REVAL_INTERVAL = 2 * 60 * 1000; // 2 minutes
// v3.6.2: Drawdown limit — was 4% (set in v3.4.0 for DCA room). But at 5x leverage
// a 4% price move = 20% ROI loss. Binance position history showed positions bleeding
// 2.4-3.7% (12-19% ROI) for hours without triggering the hard stop.
// v3.8.3: 3.5% → 2.0% for 10x leverage. At 10x, 2% price = 20% ROI loss.
// Was 3.5% when running 5x (= 17.5% ROI). Now all bots on 10x, so tighten
// to keep same ~20% ROI pain level. Gainium SL backstop also tightened 8% → 5%.
// Safety orders room: 0.3% step × 2 orders = 0.6%, well within 2%.
const REVAL_MAX_DRAWDOWN_PCT = 2.0;
// v3.2.3: Profit protection — don't flip a deal that's significantly in profit
// unless the EMA spread is convincingly wide. If a deal is up > this threshold,
// the revalidation result is overridden to "allowed" with a log note.
const REVAL_PROFIT_SHIELD_PCT = 2.0;   // Skip flip if deal is > 2% in profit
// v3.6.2: Grace period — reverted from 20min back to 5min.
// v3.6.1 extended to 20min based on theory that reval was cutting winners short.
// Binance data showed the opposite: reval wasn't cutting ANYTHING. Positions sat
// underwater 10-30 hours with no intervention. 5 min = enough for Gainium deal
// creation + first safety order, then full reval protection kicks in.
const REVAL_GRACE_PERIOD_MS = 20 * 60 * 1000; // 20 minutes (v3.7.0: was 5min) // 5 minutes
// v3.8.2: Trend-aware time stop — learned from copy trader analysis.
// Old: flat 4h/8h time stop killed ETH SHORT at 0.13% against entry while
// 1H EMAs still confirmed bearish. Copy trader held 4 days through 4.3% adverse
// and recovered because the trend was right.
//
// New logic: EMA spread determines patience.
//   Strong trend (spread ≥ 0.5%): NO time stop — trust the trend. 2% drawdown is safety net.
//   Weak trend (spread < 0.5%):   12h time stop — trend is thin, don't overstay.
const REVAL_MAX_UNDERWATER_MS = 12 * 60 * 60 * 1000; // 12 hours — only used when trend is weak
const REVAL_STRONG_TREND_SPREAD_PCT = 0.5; // EMA spread above this = strong trend, skip time stop
let revalRunning = false;

async function runRevalidation() {
  if (revalRunning) return; // prevent overlapping runs
  revalRunning = true;

  const activeUUIDs = Object.keys(ACTIVE_BOTS);
  if (activeUUIDs.length === 0) {
    revalRunning = false;
    return;
  }

  // v3.6.0: Cache exchange position map once per reval cycle instead of
  // calling getExchangePositionMap() per bot (was 8 identical API calls).
  let cachedPosMap = null;
  if (gainiumApi.isConfigured()) {
    try {
      cachedPosMap = await gainiumApi.getExchangePositionMap();
    } catch (e) {
      log(`🔄 Reval: failed to get exchange position map for cycle: ${e.message}`);
    }
  }

  for (const uuid of activeUUIDs) {
    const bot = ACTIVE_BOTS[uuid];
    if (!bot) continue;

    // v3.6.2: Grace period — 5 min for Gainium deal creation + first safety order.
    // After grace, full reval + drawdown protection.
    const ageMs = Date.now() - new Date(bot.startedAt).getTime();
    if (ageMs < REVAL_GRACE_PERIOD_MS) {
      log(`🔄 Reval: skipping ${bot.botName} — started ${Math.round(ageMs / 1000)}s ago (grace period ${Math.round(REVAL_GRACE_PERIOD_MS / 60000)}min)`);
      continue;
    }

    try {
      const result = await signalGate.revalidateSignal(bot.pair, bot.direction);

      // v3.5.0: Use DCA-averaged entry price for profit shield + drawdown check.
      // v3.6.0: Uses cached position map (one API call per cycle, not per bot).
      let effectiveEntry = bot.entryPrice;
      if (cachedPosMap && result.data.currentPrice) {
        const base = bot.pair.replace('USDT', '').replace('/USDT', '');
        const pos = cachedPosMap.get(base);
        if (pos && pos.entryPrice > 0) {
          effectiveEntry = pos.entryPrice;
          if (effectiveEntry !== bot.entryPrice) {
            log(`🔄 Reval: ${bot.botName} using DCA avgPrice $${effectiveEntry.toFixed(2)} (signal entry was $${bot.entryPrice?.toFixed(2) || '?'})`);
          }
        }
      }
      // v3.6.0: If entry price is still unknown (self-heal retrack, API failure),
      // persist the current spot price as a baseline so drawdown protection
      // activates from this cycle forward.
      if (!effectiveEntry && result.data.currentPrice) {
        effectiveEntry = result.data.currentPrice;
        bot.entryPrice = effectiveEntry;
        log(`🔄 Reval: ${bot.botName} no entry price — using spot $${effectiveEntry.toFixed(2)} as baseline for drawdown protection`);
      }

      // v3.2.3: Profit shield — if the deal is significantly in profit,
      // don't flip on a marginal EMA cross.
      if (!result.allowed && effectiveEntry && result.data.currentPrice) {
        const currentPrice = result.data.currentPrice;

        const pctProfit = bot.direction === 'LONG'
          ? ((currentPrice - effectiveEntry) / effectiveEntry) * 100
          : ((effectiveEntry - currentPrice) / effectiveEntry) * 100;

        if (pctProfit >= REVAL_PROFIT_SHIELD_PCT) {
          log(`🛡️ Profit shield: ${bot.botName} is ${pctProfit.toFixed(2)}% in profit (≥ ${REVAL_PROFIT_SHIELD_PCT}%) — overriding reval failure. Original reason: ${result.reason}`);
          result.allowed = true;
          result.reason = `PROFIT SHIELD: Deal is ${pctProfit.toFixed(2)}% in profit — EMA micro-cross ignored. Original: ${result.reason}`;
          result.data.profitShielded = true;
          result.data.dealProfitPct = parseFloat(pctProfit.toFixed(2));
        }
      }

      // v3.6.2: Price drawdown check — was 4%, now 2% to account for 5x leverage.
      // At 5x, a 2% price move = 10% ROI loss. Previously positions bled 3-3.7%
      // (15-19% ROI) without triggering the 4% hard stop.
      if (result.allowed && effectiveEntry && result.data.currentPrice) {
        const currentPrice = result.data.currentPrice;

        const pctMove = ((currentPrice - effectiveEntry) / effectiveEntry) * 100;
        const drawdown = bot.direction === 'LONG' ? -pctMove : pctMove; // positive = bad

        if (drawdown > REVAL_MAX_DRAWDOWN_PCT) {
          const reason = `PRICE DRAWDOWN: ${bot.direction} entered @ $${effectiveEntry.toFixed(2)}, now $${currentPrice.toFixed(2)} (${pctMove > 0 ? '+' : ''}${pctMove.toFixed(2)}% — exceeds ${REVAL_MAX_DRAWDOWN_PCT}% max → ~${(drawdown * 10).toFixed(0)}% ROI loss at 10x)`;
          log(`🔄 Reval FAILED: ${bot.botName} — ${reason}`);
          result.allowed = false;
          result.reason = reason;
        } else {
          log(`🔄 Reval price check: ${bot.botName} @ $${currentPrice.toFixed(2)} (${pctMove > 0 ? '+' : ''}${pctMove.toFixed(2)}% from entry $${effectiveEntry.toFixed(2)}) — within ${REVAL_MAX_DRAWDOWN_PCT}% limit`);
        }
      }

      // v3.8.2: Trend-aware time stop — learned from copy trader analysis.
      // Old: flat time stop killed positions when EMAs still confirmed the direction.
      // New: if EMA spread is strong (≥ 0.5%), trust the trend — no time stop.
      // The 2% drawdown hard stop is the real safety net.
      // Only time-stop when trend is weak (thin EMA spread) AND underwater too long.
      if (result.allowed && effectiveEntry && result.data.currentPrice) {
        const currentPrice = result.data.currentPrice;
        const pctMove = ((currentPrice - effectiveEntry) / effectiveEntry) * 100;
        const isUnderwater = (bot.direction === 'LONG' && pctMove < -REVAL_UNDERWATER_THRESHOLD_PCT) ||
                             (bot.direction === 'SHORT' && pctMove > REVAL_UNDERWATER_THRESHOLD_PCT);

        if (isUnderwater) {
          const emaSpread = result.data.emaSpreadPct || 0;
          const strongTrend = emaSpread >= REVAL_STRONG_TREND_SPREAD_PCT;
          const underwaterHours = (ageMs / (60 * 60 * 1000)).toFixed(1);

          if (strongTrend) {
            // Trend is strong — trust it. Drawdown % is the safety net.
            log(`🔄 Reval: ${bot.botName} underwater ${pctMove > 0 ? '+' : ''}${pctMove.toFixed(2)}% for ${underwaterHours}h but EMA spread ${emaSpread.toFixed(3)}% ≥ ${REVAL_STRONG_TREND_SPREAD_PCT}% — strong trend, holding`);
          } else if (ageMs > REVAL_MAX_UNDERWATER_MS) {
            // Weak trend + underwater too long → close
            const reason = `TIME STOP: ${bot.direction} underwater for ${underwaterHours}h (max ${REVAL_MAX_UNDERWATER_MS / (60 * 60 * 1000)}h) with weak trend (EMA spread ${emaSpread.toFixed(3)}% < ${REVAL_STRONG_TREND_SPREAD_PCT}%). Entry $${effectiveEntry.toFixed(2)}, now $${currentPrice.toFixed(2)} (${pctMove > 0 ? '+' : ''}${pctMove.toFixed(2)}%). Trend too thin to justify patience — closing.`;
            log(`🔄 Reval FAILED: ${bot.botName} — ${reason}`);
            result.allowed = false;
            result.reason = reason;
          } else {
            log(`🔄 Reval: ${bot.botName} underwater ${pctMove > 0 ? '+' : ''}${pctMove.toFixed(2)}% for ${underwaterHours}h — weak trend (${emaSpread.toFixed(3)}%) but within ${REVAL_MAX_UNDERWATER_MS / (60 * 60 * 1000)}h limit, holding`);
          }
        }
      }

      if (result.allowed) {
        log(`🔄 Reval OK: ${bot.botName} (${bot.pair} ${bot.direction}) — ${result.reason}`);

        // v3.1.1: ASAP re-entry monitoring — if bot is running but deal closed (TP/SL).
        // With ASAP startCondition, Gainium auto-opens next deal after 5-min cooldown.
        // Relay validates external gates — if they fail, stop the bot to prevent
        // ASAP from opening a deal into bad structure.
        if (gainiumApi.isConfigured()) {
          const botInfo = BOT_MAP[uuid];
          if (botInfo) {
            try {
              const deals = await gainiumApi.getBotDeals(uuid);
              // v3.2.8: Stale deal detection — if Gainium says deal is active but
              // the loss exceeds the -8% SL, Binance likely already closed it.
              // Force-close on Gainium to sync state.
              // v3.5.0: Use DCA avgPrice (effectiveEntry) for stale deal detection,
              // not signal entryPrice which is the daily candle close from signal time
              if (deals && deals.active > 0 && effectiveEntry && result.data.currentPrice) {
                const curPrice = result.data.currentPrice;
                const lossPct = bot.direction === 'LONG'
                  ? ((curPrice - effectiveEntry) / effectiveEntry) * 100
                  : ((effectiveEntry - curPrice) / effectiveEntry) * 100;

                if (lossPct < -8.5) {
                  // Loss exceeds SL — deal should have been closed by Binance
                  log(`🚨 STALE DEAL: ${bot.botName} showing ${deals.active} active deal(s) but loss is ${lossPct.toFixed(2)}% (beyond -8% SL)`);
                  if (canSendTelegramAlert(uuid, 'stale-deal')) {
                    markTelegramAlertSent(uuid, 'stale-deal');
                    sendTelegramAlert(
                      `🚨 STALE DEAL: ${bot.botName}\n\n` +
                      `Gainium shows an active deal but the loss (${lossPct.toFixed(2)}%) exceeds the -8% stop loss. ` +
                      `Binance likely already closed this position.\n\n` +
                      `Entry: $${effectiveEntry.toFixed(2)} | Now: $${curPrice.toFixed(2)}\n\n` +
                      `Attempting to force-close the stale Gainium deal...\n\n` +
                      `${istTimestamp()}`
                    ).catch(() => {});
                  }
                  // Try REST API close to sync Gainium state
                  try {
                    const restResult = await gainiumApi.closeDealsViaApi(botInfo.mongoId, bot.botName);
                    log(`🚨 Stale deal REST close: ${restResult.closed} closed, ${restResult.failed} failed`);
                  } catch (staleErr) {
                    log(`🚨 Stale deal REST close error: ${staleErr.message}`);
                  }
                }
              }

              if (deals && deals.active === 0) {
                // Deal closed (TP/SL). ASAP will auto-open next deal after cooldown.
                // Relay's external gates provide safety — stop bot if gates fail.
                const fullGate = await signalGate.validateSignal(bot.pair, bot.direction);
                if (fullGate.allowed) {
                  // External gates pass — ASAP will re-open after 5-min cooldown
                  bot.entryPrice = fullGate.data.currentPrice || bot.entryPrice;
                  log(`🔄 Re-entry: ${bot.botName} deal closed, external gates PASS — ASAP will re-enter after cooldown @ ~$${bot.entryPrice?.toFixed(2) || '?'}`);
                  // Only send Telegram once per hour per bot (not every 2 min)
                  if (canSendTelegramAlert(uuid, 'gated-reentry')) {
                    markTelegramAlertSent(uuid, 'gated-reentry');
                    sendTelegramAlert(
                      `🔄 Deal closed — re-entering\n\n` +
                      `Signal: 1H EMA 9/21\n` +
                      `${bot.botName} took profit or hit stop loss. The market still supports a ${bot.direction} on ${bot.pair}:\n\n` +
                      `• 1H EMAs (9 vs 21): ${fullGate.data.shortTermTrend || '?'} — moving averages still aligned\n` +
                      `• RSI(14): ${fullGate.data.rsi14 || '?'} — momentum in range\n` +
                      `• Price: $${fullGate.data.currentPrice?.toFixed(2) || '?'}\n\n` +
                      `A new deal will open automatically after the 5-minute cooldown.\n\n` +
                      `${istTimestamp()}`
                    ).catch(() => {});
                  }
                } else {
                  // External gates fail — stop bot before ASAP reopens
                  log(`🔄 Re-entry: ${bot.botName} deal closed, external gates FAILED — stopping bot`);
                  tradeJournal.recordExit({ botUuid: uuid, exitPrice: fullGate.data?.currentPrice || result.data.currentPrice, exitReason: 'gate-stop' });
                  try {
                    await sendAction({ action: 'stopBot', uuid });
                  } catch (stopErr) {
                    log(`🔄 Re-entry: stopBot failed for ${bot.botName}: ${stopErr.message}`);
                  }
                  delete ACTIVE_BOTS[uuid];
                  delete LAST_DIRECTION[bot.pair];
                  sendTelegramAlert(
                    `⏹️ ${bot.botName} stopped — market shifted\n\n` +
                    `The deal closed, but the market no longer supports a ${bot.direction}:\n` +
                    `${fullGate.reason}\n\n` +
                    `The bot has been paused to avoid opening a new deal into a bad setup. It will wait for the next TradingView crossover signal to re-enter.\n\n` +
                    `${istTimestamp()}`
                  ).catch(() => {});
                }
              }
            } catch (dealCheckErr) {
              log(`🔄 Re-entry: deal check failed for ${bot.botName}: ${dealCheckErr.message}`);
              // Don't kill the bot on API errors — just skip this cycle
            }
          }
        }
      } else {
        // Conditions changed — attempt to close and flip
        log(`🔄 Reval FAILED: ${bot.botName} — ${result.reason}`);

        // ── v3.2.8: Don't orphan positions on failed close ──────────────
        // Previously we deleted ACTIVE_BOTS[uuid] immediately, before
        // knowing if the close would succeed. If close failed, the position
        // was orphaned — no revalidation, no protection, no monitoring.
        //
        // New approach: attempt the close first. Only remove from ACTIVE_BOTS
        // if the close succeeds. If it fails, keep monitoring the position.
        // A monitored losing position is better than an unmonitored one.

        // Clear rising-edge so next signal for this pair is treated as fresh
        delete LAST_DIRECTION[bot.pair];

        // Record this stop as a flip event for circuit breaker tracking
        recordFlip(bot.pair);

        // ── Check circuit breaker BEFORE attempting auto-flip ──
        const cbCheck = checkCircuitBreaker(bot.pair);
        let flipResult = null;
        const oppositeDir = bot.direction === 'LONG' ? 'SHORT' : 'LONG';
        const oppositeBot = findOppositeBot(bot.pair, bot.direction);

        if (cbCheck.parked && cbCheck.tripped) {
          log(`🔄 ⚡ CIRCUIT BREAKER TRIPPED: ${bot.pair} — ${cbCheck.reason}`);
          sendTelegramAlert(
            `⚡ Circuit breaker tripped — ${bot.pair}\n\n` +
            `${bot.pair} has flipped direction too many times in a short window. This usually means the market is choppy and indecisive, so the system is stepping back.\n\n` +
            `No trades on ${bot.pair} for 30 minutes. Other pairs continue normally.\n\n` +
            `${istTimestamp()}`
          ).catch(() => {});
          flipResult = { flipped: false, reason: cbCheck.reason };
        } else if (cbCheck.parked) {
          log(`🔄 ⚡ ${bot.pair} still parked (circuit breaker) — skipping auto-flip`);
          flipResult = { flipped: false, reason: 'Circuit breaker still parked' };
        } else if (!oppositeBot) {
          flipResult = { flipped: false, reason: `No opposite bot found for ${bot.pair}` };
        } else if (isFlipOnCooldown(bot.pair)) {
          const cooldownRemain = Math.ceil((FLIP_COOLDOWN_MS - (Date.now() - new Date(FLIP_COOLDOWN[bot.pair]).getTime())) / 1000);
          log(`🔄 Auto-flip: ${bot.pair} on cooldown (${cooldownRemain}s remaining) — skipping`);
          flipResult = { flipped: false, reason: `Flip cooldown active (${cooldownRemain}s remaining)` };
        } else {
          // Gate-check the opposite direction before building the action sequence
          log(`🔄 Auto-flip: checking ${bot.pair} ${oppositeDir} through full 4-gate validation...`);
          try {
            const gateResult = await signalGate.validateSignal(bot.pair, oppositeDir);
            if (!gateResult.allowed) {
              log(`🔄 Auto-flip: ${bot.pair} ${oppositeDir} BLOCKED — ${gateResult.reason}`);
              flipResult = { flipped: false, reason: gateResult.reason };
            } else {
              log(`🔄 Auto-flip: ${oppositeBot.name} PASSED all gates — executing verified flip sequence`);
              flipResult = { flipped: false, reason: 'pending' }; // updated below
            }
          } catch (gateErr) {
            log(`🔄 Auto-flip: gate error for ${bot.pair} ${oppositeDir}: ${gateErr.message}`);
            flipResult = { flipped: false, reason: `Gate error: ${gateErr.message}` };
          }
        }

        // Build action sequence: always close+stop the old bot.
        // If gates passed, also include startBot for the opposite bot.
        const revalActions = [
          { action: 'closeAllDeals', uuid },
          { action: 'stopBot', uuid },
        ];
        if (flipResult && flipResult.reason === 'pending' && oppositeBot) {
          revalActions.push({ action: 'startBot', uuid: oppositeBot.uuid });
        }

        // v3.2.4: Execute through processActions — same verified pipeline as
        // TradingView crossovers. Includes double-tap, flat verification, and
        // abort-on-failure for startBot.
        const revalRequestId = `reval-${bot.pair}-${Date.now()}`;
        const revalContext = {
          pair: bot.pair,
          direction: oppositeDir,
          price: result.data.currentPrice || null,
        };

        try {
          const processResult = await processActions(revalActions, revalRequestId, false, revalContext);

          if (processResult && processResult.completed) {
            // Close succeeded — safe to remove old bot from tracking
            // v3.6.0: Journal — record exit reason based on what triggered the reval failure
            const exitReason = result.reason?.includes('PRICE DRAWDOWN') ? 'drawdown'
              : result.reason?.includes('TIME STOP') ? 'time-stop'
              : 'reval-flip';
            tradeJournal.recordExit({ botUuid: uuid, exitPrice: result.data.currentPrice, exitReason });
            delete ACTIVE_BOTS[uuid];

            // Update tracking based on outcome
            if (flipResult && flipResult.reason === 'pending' && oppositeBot) {
              // Flip succeeded — track the new bot
              // v3.6.0: Use currentPrice from the reval check already done — no need
              // for a second validateSignal call (was making redundant API calls for
              // daily candles, 1H candles, spot price, and whale positions).
              ACTIVE_BOTS[oppositeBot.uuid] = {
                pair: bot.pair,
                direction: oppositeDir,
                botName: oppositeBot.name,
                startedAt: new Date().toISOString(),
                entryPrice: result.data.currentPrice || null,
                origin: 'auto-flip',
              };
              LAST_ACTIVE[bot.pair] = Date.now();
              LAST_DIRECTION[bot.pair] = oppositeDir;
              FLIP_COOLDOWN[bot.pair] = new Date().toISOString();
              recordFlip(bot.pair);
              flipResult = { flipped: true, botName: oppositeBot.name, gateData: result.data || {} };
              tradeJournal.recordEntry({ pair: bot.pair, direction: oppositeDir, botName: oppositeBot.name, botUuid: oppositeBot.uuid, entryPrice: result.data.currentPrice, origin: 'auto-flip', gateData: result.data });
              log(`🔄 Auto-flip: ${oppositeBot.name} started via verified pipeline (cooldown set)`);
            } else {
              // Close-only succeeded (no flip attempted or gates blocked)
              log(`🔄 Reval: ${bot.botName} closed and stopped successfully`);
            }
          } else {
            // v3.2.8: Close FAILED — keep bot in ACTIVE_BOTS for continued monitoring
            // Don't orphan the position. Revalidation will retry next cycle.
            log(`🔄 Reval: close failed for ${bot.botName} — keeping in ACTIVE_BOTS for continued monitoring`);
            // Restore LAST_DIRECTION since we're not actually changing state
            LAST_DIRECTION[bot.pair] = bot.direction;

            if (flipResult && flipResult.reason === 'pending') {
              flipResult = { flipped: false, reason: 'Close failed — position still monitored, will retry' };
            }

            sendTelegramAlert(
              `⚠️ ${bot.botName}: close attempt failed\n\n` +
              `Revalidation tried to close this position but couldn't verify the deal closed on Binance. ` +
              `The bot is still tracked and protected by revalidation — will retry next cycle.\n\n` +
              `${istTimestamp()}`
            ).catch(() => {});
          }
        } catch (processErr) {
          log(`🔄 Auto-flip: processActions failed for ${bot.botName}: ${processErr.message}`);
          // Keep in ACTIVE_BOTS on error too
          LAST_DIRECTION[bot.pair] = bot.direction;
          if (flipResult && flipResult.reason === 'pending') {
            flipResult = { flipped: false, reason: `processActions error: ${processErr.message}` };
          }
        }

        // Alert to Telegram (includes flip result)
        const isDrawdown = result.reason && result.reason.includes('PRICE DRAWDOWN');
        const isTimeStop = result.reason && result.reason.includes('TIME STOP');
        let alertMsg;
        if (isDrawdown) {
          alertMsg = `🛑 ${bot.botName} closed — price moved against us\n\n` +
            `Signal: 1H EMA 9/21 | Reval check\n` +
            `The ${bot.direction} position was losing too much (past the ${REVAL_MAX_DRAWDOWN_PCT}% safety limit = ~${(REVAL_MAX_DRAWDOWN_PCT * 10).toFixed(0)}% ROI at 10x), so the deal was closed to cut losses.\n\n` +
            `1H trend: ${result.data.shortTermTrend || '?'} · RSI(14): ${result.data.rsi14 || '?'} ${result.data.rsiDirection || ''}`;
        } else if (isTimeStop) {
          alertMsg = `⏰ ${bot.botName} closed — weak trend + underwater too long\n\n` +
            `Signal: 1H EMA 9/21 | Time stop (weak trend)\n` +
            `This ${bot.direction} has been losing for over ${REVAL_MAX_UNDERWATER_MS / (60 * 60 * 1000)} hours AND the EMA spread is thin (trend not strong enough to justify patience).\n\n` +
            `${result.reason}\n\n` +
            `1H trend: ${result.data.shortTermTrend || '?'} · RSI(14): ${result.data.rsi14 || '?'} ${result.data.rsiDirection || ''}`;
        } else {
          alertMsg = `🛑 ${bot.botName} closed — market structure changed\n\n` +
            `Signal: 1H EMA 9/21 | Reval check\n` +
            `The 1H checks ("revalidation") found the market no longer supports this ${bot.direction}:\n` +
            `${result.reason}\n\n` +
            `1H trend: ${result.data.shortTermTrend || '?'} · RSI(14): ${result.data.rsi14 || '?'} ${result.data.rsiDirection || ''}`;
        }

        if (flipResult && flipResult.flipped) {
          alertMsg += `\n\n↔️ Auto-flipped to ${flipResult.botName} (verified)\n` +
            `The opposite direction passed all checks and the old position was verified closed before starting.\n` +
            `1H trend: ${flipResult.gateData?.shortTermTrend || '?'} · RSI(14): ${flipResult.gateData?.rsi14 || '?'} ${flipResult.gateData?.rsiDirection || ''}`;
        } else if (flipResult) {
          alertMsg += `\n\n⏸️ Didn't flip to the other direction: ${flipResult.reason}`;
        }
        alertMsg += `\n\n${istTimestamp()}`;

        sendTelegramAlert(alertMsg).catch(() => {});
      }
    } catch (err) {
      log(`🔄 Reval error for ${bot.botName}: ${err.message}`);
    }
  }

  revalRunning = false;
}

// Start the re-validation interval
setInterval(runRevalidation, REVAL_INTERVAL);

// ── Bot Self-Heal Monitor (v3.2.8) ─────────────────────────────────────
// Catches orphaned pairs — where both Long and Short bots are "closed"
// with 0 active deals and no bot is tracked in ACTIVE_BOTS.
//
// This happens when:
//   1. Relay stops a bot (reval flip / direction change)
//   2. The old deal keeps running on Binance (TP/SL not yet hit)
//   3. Deal eventually closes, but bot is already stopped → no ASAP re-entry
//   4. Pair goes dark until the next TradingView signal (could be hours)
//
// Self-heal checks every 5 minutes: if a pair is orphaned, runs the signal
// gate to determine the correct direction and restarts the appropriate bot.
//
// Respects: pause mode, circuit breaker parks, active deals still running.

const SELF_HEAL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const SELF_HEAL_PAIRS = ['SOL', 'ETH', 'XRP', 'BTC'];
let selfHealRunning = false;

async function runSelfHeal() {
  if (selfHealRunning) return;
  if (PAUSED) return;
  if (!gainiumApi.isConfigured()) return;

  selfHealRunning = true;

  try {
    // Single API call to get all bot statuses — needed by both phases
    const botStatuses = await gainiumApi.getAllBotStatuses();
    if (!botStatuses) {
      log(`🩺 Self-heal: API call failed — skipping this cycle`);
      selfHealRunning = false;
      return;
    }

    // ── Phase 1: Orphaned Deal Scan (v3.8.3) ───────────────────────────
    // Check ALL pairs for deals that exist on Gainium but aren't tracked
    // in ACTIVE_BOTS. This catches the critical scenario where a flip
    // started the new direction but the old deal didn't close — the pair
    // has an active bot (new direction) so it's not "orphaned", but the
    // old deal bleeds unmonitored.
    // This phase runs EVERY cycle, regardless of whether pairs are orphaned.
    for (const pair of SELF_HEAL_PAIRS) {
      const longBot = findBot(pair, 'LONG');
      const shortBot = findBot(pair, 'SHORT');
      if (!longBot || !shortBot) continue;

      const longStatus = botStatuses.get(longBot.uuid);
      const shortStatus = botStatuses.get(shortBot.uuid);
      if (!longStatus || !shortStatus) continue;

      for (const [bot, bStatus, dir] of [
        [longBot, longStatus, 'LONG'],
        [shortBot, shortStatus, 'SHORT'],
      ]) {
        if (bStatus.deals.active > 0 && !ACTIVE_BOTS[bot.uuid]) {
          ACTIVE_BOTS[bot.uuid] = {
            pair,
            direction: dir,
            botName: bot.name,
            // Backdate startedAt so reval's grace period doesn't delay monitoring
            startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            entryPrice: null, // will be fetched by reval's getExchangePositionMap
            origin: 'self-heal-retrack',
          };
          LAST_ACTIVE[pair] = Date.now();
          LAST_DIRECTION[pair] = dir;
          log(`🩺 Self-heal: RE-TRACKED ${bot.name} (${dir}) — deal active but not monitored. Now under reval + drawdown protection.`);
          sendTelegramAlert(
            `🚨 Orphaned deal re-tracked: ${bot.name}\n\n` +
            `Found a ${dir} deal still open on Gainium/Binance but NOT being monitored by the relay. ` +
            `This can happen when a direction flip fails to close the old deal.\n\n` +
            `The relay is now monitoring this position with full revalidation + drawdown protection.\n\n` +
            `${istTimestamp()}`
          ).catch(() => {});
        }
      }
    }

    // ── Phase 2: Orphaned Pair Recovery ─────────────────────────────────
    // Check pairs with NO active bot — either re-enter or detect stale state.
    const activePairs = new Set(Object.values(ACTIVE_BOTS).map(b => b.pair));
    const orphanedPairs = SELF_HEAL_PAIRS.filter(p => !activePairs.has(p));
    if (orphanedPairs.length === 0) {
      selfHealRunning = false;
      return;
    }

    log(`🩺 Self-heal: checking ${orphanedPairs.length} pair(s) with no active bot: ${orphanedPairs.join(', ')}`);

    for (const pair of orphanedPairs) {
      try {
        // v3.2.8 Guardrail 1: Recent-activity requirement
        // Only recover pairs that were active within the last 6 hours.
        // A pair that's been intentionally flat won't get auto-restarted.
        // v3.8.0: Cold-start mode bypasses this check — on fresh startup,
        // no pairs have activity records yet, but we still want to detect
        // the existing market trend and enter if the gates pass.
        const lastActive = LAST_ACTIVE[pair];
        if (!lastActive && !COLD_START_MODE) {
          log(`🩺 Self-heal: ${pair} — no activity record (never started by this relay instance) — skipping`);
          continue;
        }
        if (lastActive) {
          const ageMs = Date.now() - lastActive;
          if (ageMs > SELF_HEAL_MAX_AGE_MS) {
            log(`🩺 Self-heal: ${pair} — last active ${Math.round(ageMs / 60000)}min ago (>${SELF_HEAL_MAX_AGE_MS / 3600000}h) — too old, skipping`);
            continue;
          }
        }
        if (COLD_START_MODE && !lastActive) {
          log(`🧭 Cold-start: ${pair} — no prior activity, scanning market for existing trend...`);
        }

        // v3.2.8 Guardrail 2: Per-pair self-heal cooldown
        // Max one restart per pair per 30 minutes to prevent silent churn.
        const lastHeal = SELF_HEAL_COOLDOWNS[pair];
        if (lastHeal && (Date.now() - lastHeal) < SELF_HEAL_COOLDOWN_MS) {
          const remainMin = Math.ceil((SELF_HEAL_COOLDOWN_MS - (Date.now() - lastHeal)) / 60000);
          log(`🩺 Self-heal: ${pair} — cooldown active (${remainMin}min remaining) — skipping`);
          continue;
        }

        // Check circuit breaker
        // v3.5.0 fix: was pair+'USDT' but recordFlip() uses bare pair name (e.g. 'SOL')
        const cbCheck = checkCircuitBreaker(pair);
        if (cbCheck.parked) {
          log(`🩺 Self-heal: ${pair} parked by circuit breaker — skipping`);
          continue;
        }

        // Find both bots for this pair
        const longBot = findBot(pair, 'LONG');
        const shortBot = findBot(pair, 'SHORT');
        if (!longBot || !shortBot) {
          log(`🩺 Self-heal: ${pair} missing Long or Short bot in BOT_MAP — skipping`);
          continue;
        }

        // Check their status on Gainium
        const longStatus = botStatuses.get(longBot.uuid);
        const shortStatus = botStatuses.get(shortBot.uuid);

        if (!longStatus || !shortStatus) {
          log(`🩺 Self-heal: ${pair} — couldn't find bot status on Gainium — skipping`);
          continue;
        }

        // Only self-heal if BOTH bots are closed/stopped with 0 active deals
        const longIdle = (longStatus.status === 'closed' && longStatus.deals.active === 0);
        const shortIdle = (shortStatus.status === 'closed' && shortStatus.deals.active === 0);

        if (!longIdle || !shortIdle) {
          // Phase 1 already handled re-tracking — just log and move on
          if (longStatus.deals.active > 0 || shortStatus.deals.active > 0) {
            log(`🩺 Self-heal: ${pair} — deal still running (L:${longStatus.deals.active} S:${shortStatus.deals.active}) — Phase 1 handles monitoring`);
          }
          continue;
        }

        // Both bots are closed with 0 deals — pair is orphaned (or cold start)
        const scanLabel = (COLD_START_MODE && !lastActive) ? '🧭 Cold-start' : '🩺 Self-heal';
        log(`${scanLabel}: ${pair} — both bots closed, 0 deals. Running signal gate...`);

        // v3.5.0: Prefer the last known direction (if available) — avoids
        // always defaulting to LONG when both directions pass gates.
        const lastDir = LAST_DIRECTION[pair];
        const dirOrder = lastDir === 'SHORT' ? ['SHORT', 'LONG'] : ['LONG', 'SHORT'];

        let bestDirection = null;
        let bestGateResult = null;

        for (const dir of dirOrder) {
          try {
            const gateResult = await signalGate.validateSignal(pair, dir);
            if (gateResult.allowed) {
              bestDirection = dir;
              bestGateResult = gateResult;
              break;
            }
          } catch (gateErr) {
            log(`🩺 Self-heal: ${pair} ${dir} gate error: ${gateErr.message}`);
          }
        }

        if (!bestDirection) {
          log(`${scanLabel}: ${pair} — neither direction passes signal gate. Will retry next cycle.`);
          const alertType = COLD_START_MODE ? 'cold-start-blocked' : 'self-heal-blocked';
          if (canSendTelegramAlert(pair, alertType)) {
            markTelegramAlertSent(pair, alertType);
            const header = COLD_START_MODE ? '🧭 Cold-start scan' : '🩺 Self-heal';
            sendTelegramAlert(
              `${header}: ${pair} — no clear direction\n\n` +
              `Both ${pair} bots are stopped with no deals. The system checked if it should enter, but neither LONG nor SHORT passed the 1H signal gate checks.\n\n` +
              `Will keep checking every 5 minutes until a clear direction emerges, or the next TradingView signal arrives.\n\n` +
              `${istTimestamp()}`
            ).catch(() => {});
          }
          continue;
        }

        // Found a valid direction — start the bot
        const targetBot = bestDirection === 'LONG' ? longBot : shortBot;
        const origin = (COLD_START_MODE && !lastActive) ? 'cold-start' : 'self-heal';
        log(`${scanLabel}: ${pair} → starting ${targetBot.name} (${bestDirection})`);

        try {
          await sendAction({ action: 'startBot', uuid: targetBot.uuid });

          // Track in ACTIVE_BOTS
          ACTIVE_BOTS[targetBot.uuid] = {
            pair,
            direction: bestDirection,
            botName: targetBot.name,
            startedAt: new Date().toISOString(),
            entryPrice: bestGateResult.data?.currentPrice || null,
            origin,
          };
          tradeJournal.recordEntry({ pair, direction: bestDirection, botName: targetBot.name, botUuid: targetBot.uuid, entryPrice: bestGateResult.data?.currentPrice, origin, gateData: bestGateResult.data });
          LAST_ACTIVE[pair] = Date.now();
          SELF_HEAL_COOLDOWNS[pair] = Date.now();
          LAST_DIRECTION[pair] = bestDirection;

          log(`${scanLabel}: ✅ ${targetBot.name} started successfully`);
          const header = origin === 'cold-start'
            ? `🧭 Cold-start: ${targetBot.name} entered\n\nSystem detected an existing ${bestDirection} trend on ${pair} at startup. All 1H signal gates passed — entering position:`
            : `🩺 Self-heal: ${targetBot.name} restarted\n\nBoth ${pair} bots were stopped with no active deals (orphaned pair). Confirmed ${bestDirection} is the correct direction:`;
          sendTelegramAlert(
            `${header}\n\n` +
            `• 1H trend: ${bestGateResult.data?.shortTermTrend || '?'}\n` +
            `• RSI(14): ${bestGateResult.data?.rsi14 || '?'} ${bestGateResult.data?.rsiDirection || ''}\n` +
            `• Price: $${bestGateResult.data?.currentPrice?.toFixed(2) || '?'}\n\n` +
            `A new deal will open automatically via ASAP start.\n\n` +
            `${istTimestamp()}`
          ).catch(() => {});
        } catch (startErr) {
          log(`${scanLabel}: ❌ startBot failed for ${targetBot.name}: ${startErr.message}`);
          sendTelegramAlert(
            `${scanLabel} FAILED: ${targetBot.name}\n\n` +
            `Tried to start ${targetBot.name} but the webhook failed: ${startErr.message}\n\n` +
            `Will retry next cycle.\n\n` +
            `${istTimestamp()}`
          ).catch(() => {});
        }
      } catch (pairErr) {
        log(`🩺 Self-heal: error processing ${pair}: ${pairErr.message}`);
      }
    }
  } catch (err) {
    log(`🩺 Self-heal: unexpected error: ${err.message}`);
  }

  // v3.8.0: Clear cold-start mode after first run
  if (COLD_START_MODE) {
    log(`🧭 Cold-start scan complete — switching to normal self-heal mode`);
    COLD_START_MODE = false;
  }

  selfHealRunning = false;
}

// Start the self-heal interval
setInterval(runSelfHeal, SELF_HEAL_INTERVAL);
// Run once on startup after a short delay (catches orphans from redeploys)
setTimeout(runSelfHeal, 30 * 1000);

// ── Daily P&L Summary (v3.6.0) ─────────────────────────────────────────
// Sends a daily summary to Telegram at 23:30 IST.
// Uses setInterval checking every 5 min — simple, no cron dependency.
let lastDailySummaryDate = null;

function checkDailySummary() {
  const now = new Date();
  // Convert to IST
  const istHour = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
  const istMin = (now.getUTCMinutes() + 30) % 60;
  const today = tradeJournal.getTodayStats();
  const todayDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000)).toISOString().split('T')[0];

  // Send between 23:30-23:35 IST, once per day
  if (istHour === 23 && istMin >= 30 && istMin < 35 && lastDailySummaryDate !== todayDate) {
    lastDailySummaryDate = todayDate;
    const summary = tradeJournal.formatDailySummary();
    sendTelegramAlert(summary).catch(() => {});
    log(`📊 Daily P&L summary sent for ${todayDate}`);
  }
}
setInterval(checkDailySummary, 5 * 60 * 1000); // Check every 5 min

// ── Whale Wallet Health Check (v3.6.0) ─────────────────────────────────
// Runs on the self-heal interval. If a wallet goes stale (7+ days no
// position on our coins), alert once via Telegram.
let lastWhaleHealthDate = null;

function checkWhaleHealth() {
  const alerts = tradeJournal.checkWhaleWalletHealth();
  if (alerts.length === 0) return;

  const today = new Date().toISOString().split('T')[0];
  if (lastWhaleHealthDate === today) return; // Once per day

  lastWhaleHealthDate = today;
  const msg = `🐋 Whale wallet health alert\n\n` +
    alerts.map(a => `⚠️ ${a.message}`).join('\n') +
    `\n\nGate 5 may be degraded — these wallets aren't providing data for our coins.\n\n${istTimestamp()}`;
  sendTelegramAlert(msg).catch(() => {});
  log(`🐋 Whale wallet staleness alert sent: ${alerts.map(a => a.label).join(', ')}`);
}
// Run alongside self-heal (every 5 min)
setInterval(checkWhaleHealth, SELF_HEAL_INTERVAL);

// ── Telegram Bot Commands (v3.2.8) ──────────────────────────────────────
// Lets Manav query the system from Telegram on his phone.
// POST /telegram — receives updates from Telegram webhook.
// Supported commands: /positions, /status, /bots, /trades, /journal, /whales

async function handleTelegramCommand(text, chatId) {
  const cmd = (text || '').trim().toLowerCase().split(/\s+/)[0];

  if (cmd === '/positions') {
    // Single API call to get ALL open deals, then match to our bots
    let lines = ['📊 <b>Active Positions</b>\n'];
    let totalProfit = 0;
    let foundDeals = 0;

    // Build mongoId → botInfo lookup
    const mongoToBot = {};
    for (const [uuid, botInfo] of Object.entries(BOT_MAP)) {
      mongoToBot[botInfo.mongoId] = { ...botInfo, uuid };
    }

    try {
      // One API call — listAllOpenDeals returns every open deal
      const allDeals = await gainiumApi.listAllOpenDeals();
      for (const deal of allDeals) {
        const botInfo = mongoToBot[deal.botId];
        if (!botInfo) continue; // not one of our bots

        foundDeals++;
        const pair = deal.symbol?.symbol || botInfo.name;
        const entry = deal.avgPrice || 0;
        const pnl = deal.stats?.unrealizedProfit || 0;
        const margin = deal.usage?.currentUsd || deal.cost || 0;
        // Price deviation % (what TP is measured against)
        const pctPrice = margin > 0 ? ((pnl / (margin * 5)) * 100).toFixed(1) : '0.0';
        totalProfit += pnl;

        const dir = botInfo.name.includes('Short') ? 'SHORT' : 'LONG';
        const bar = buildProgressBar(parseFloat(pctPrice), 5);

        const pctFloat = parseFloat(pctPrice);
        const shieldStatus = pctFloat >= 2.0 ? '✅' : `${(2.0 - pctFloat).toFixed(1)}% away`;
        const movingSLStatus = pctFloat >= 2.5 ? '✅ Active' : `${(2.5 - pctFloat).toFixed(1)}% away`;
        const toTP = (5.0 - pctFloat).toFixed(1);

        lines.push(`<b>${pair} ${dir}</b>`);
        lines.push(`  Entry: $${entry}  |  P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pctPrice}%)`);
        lines.push(`  ${buildProgressBar(pctFloat, 5)} → 5% TP (${toTP}% to go)`);
        lines.push(`  Profit Shield: ${shieldStatus}  |  Moving SL: ${movingSLStatus}`);
        lines.push('');
      }
    } catch (err) {
      log(`Telegram /positions error: ${err.message}`);
      lines.push('⚠️ Could not fetch deals from Gainium API.');
    }

    if (foundDeals === 0) {
      lines.push('No open deals on Gainium.');
    } else {
      lines.push(`<b>Gainium total: ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}</b>`);
    }

    // Exchange ground truth via Gainium (Gainium reads Binance positions directly)
    if (foundDeals > 0) {
      try {
        const exchangeMap = await gainiumApi.getExchangePositionMap();
        if (exchangeMap.size > 0) {
          lines.push('\n📈 <b>Exchange Positions (via Gainium)</b>\n');
          let exchangeTotal = 0;
          for (const [pair, pos] of exchangeMap) {
            exchangeTotal += pos.pnl;
            lines.push(`<b>${pair} ${pos.side}</b> — entry $${pos.entryPrice.toFixed(2)}, mark $${pos.markPrice.toFixed(2)}, P&L ${pos.pnl >= 0 ? '+' : ''}$${pos.pnl.toFixed(2)}, ${pos.leverage}x ${pos.marginType}`);
          }
          lines.push(`\n<b>Exchange total: ${exchangeTotal >= 0 ? '+' : ''}$${exchangeTotal.toFixed(2)}</b>`);
        }
      } catch (err) {
        log(`Telegram /positions exchange data error: ${err.message}`);
      }
    }

    lines.push(`\n${istTimestamp()} IST`);
    return lines.join('\n');
  }

  if (cmd === '/status') {
    const uptime = Math.floor(process.uptime());
    const hrs = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);

    const activeCount = Object.keys(ACTIVE_BOTS).length;
    const activePairs = Object.values(ACTIVE_BOTS).map(b => `${b.pair} ${b.direction}`).join(', ') || 'none tracked';

    const cbParked = Object.entries(CIRCUIT_BREAKER)
      .filter(([, v]) => v.parkedUntil && new Date(v.parkedUntil) > new Date())
      .map(([pair]) => pair);

    let statusLines = [
      '🔧 <b>System Status</b>\n',
      `Version: v${VERSION}`,
      `State: ${PAUSED ? '⏸️ PAUSED' : '✅ Running'}`,
      `Uptime: ${hrs}h ${mins}m`,
      `Strategy: ${STRATEGY_MODE}`,
      `Active bots: ${activeCount} (${activePairs})`,
      `Circuit breaker: ${cbParked.length > 0 ? '⚠️ Parked: ' + cbParked.join(', ') : '✅ Clear'}`,
      `API: ${gainiumApi.isConfigured() ? '✅' : '❌'}`,
      `\n${istTimestamp()} IST`,
    ];
    return statusLines.join('\n');
  }

  if (cmd === '/bots') {
    let botLines = ['🤖 <b>Bot Overview</b>\n'];
    for (const [uuid, botInfo] of Object.entries(BOT_MAP)) {
      const active = ACTIVE_BOTS[uuid];
      const icon = active ? '🟢' : '⚪';
      const extra = active ? ` — ${active.direction} since ${active.startedAt?.substring(11, 16) || '?'} UTC` : '';
      botLines.push(`${icon} ${botInfo.name}${extra}`);
    }
    botLines.push(`\n${istTimestamp()} IST`);
    return botLines.join('\n');
  }

  if (cmd === '/binance') {
    if (!binanceApi.isConfigured()) {
      return '❌ Binance API not configured (missing env vars).';
    }
    try {
      const result = await binanceApi.testConnection();
      let lines = ['🔍 <b>Binance API Diagnostic</b>\n'];
      lines.push(`Key: ${result.keyPrefix}`);
      lines.push(`HTTP: ${result.status}`);
      lines.push(`OK: ${result.ok}`);

      if (!result.ok) {
        // Show the error — this is what we need to debug
        const bodyStr = typeof result.body === 'object' ? JSON.stringify(result.body) : String(result.body);
        lines.push(`\n<b>Error:</b> ${bodyStr.substring(0, 500)}`);

        // Provide guidance based on common Binance errors
        if (result.status === 401 || (result.body?.code === -2015)) {
          lines.push('\n💡 API key invalid or missing Futures permission.');
          lines.push('Fix: Binance → API Management → Edit key → Enable Futures.');
        } else if (result.body?.code === -1021) {
          lines.push('\n💡 Timestamp outside recvWindow. Server clock may be off.');
        } else if (result.body?.code === -2014) {
          lines.push('\n💡 Bad API key format.');
        }
      } else {
        lines.push(`Symbols tracked: ${result.totalSymbols}`);
        lines.push(`Open positions: ${result.openPositions}`);
        if (result.positions?.length > 0) {
          lines.push('');
          for (const p of result.positions) {
            lines.push(`${p.symbol} ${p.side} — entry $${parseFloat(p.entryPrice).toFixed(2)}, P&L $${parseFloat(p.pnl).toFixed(2)}`);
          }
        }
      }
      lines.push(`\n${istTimestamp()} IST`);
      return lines.join('\n');
    } catch (err) {
      return `❌ Binance test error: ${err.message}`;
    }
  }

  if (cmd === '/trades') {
    return tradeJournal.formatTradesSummary();
  }

  if (cmd === '/journal') {
    return tradeJournal.formatJournalSummary();
  }

  if (cmd === '/whales') {
    const status = tradeJournal.getWhaleWalletStatus();
    if (typeof status === 'object' && !Array.isArray(status)) {
      return `🐋 <b>Whale Wallets</b>\n\n${status.status}\n\n${istTimestamp()} IST`;
    }
    let lines = ['🐋 <b>Whale Wallet Health</b>\n'];
    for (const w of status) {
      const icon = w.stale ? '⚠️' : '✅';
      lines.push(`${icon} ${w.label}: ${w.lastCoin} ${w.lastDirection} — seen ${w.lastSeen}${w.stale ? ' (STALE)' : ''}`);
    }
    const alerts = tradeJournal.checkWhaleWalletHealth();
    if (alerts.length > 0) {
      lines.push('\n⚠️ <b>Stale Alerts:</b>');
      for (const a of alerts) lines.push(`  ${a.message}`);
    }
    lines.push(`\n${istTimestamp()} IST`);
    return lines.join('\n');
  }

  // Unknown command — show help
  return '🤖 <b>Sentinel Commands</b>\n\n' +
    '/positions — Current open deals with P&L\n' +
    '/trades — Open trades + today\'s closed\n' +
    '/journal — Full session stats + win rate\n' +
    '/whales — Whale wallet health status\n' +
    '/status — System health & uptime\n' +
    '/bots — Bot overview (active/stopped)\n' +
    '/binance — Binance API diagnostic';
}

function buildProgressBar(currentPct, targetPct) {
  const blocks = 10;
  const filled = Math.min(blocks, Math.max(0, Math.round((currentPct / targetPct) * blocks)));
  return '▓'.repeat(filled) + '░'.repeat(blocks - filled) + ` ${currentPct}%`;
}

app.post('/telegram', async (req, res) => {
  try {
    const update = req.body;
    const message = update?.message;
    if (!message || !message.text || !message.chat?.id) {
      return res.sendStatus(200); // Ignore non-text updates
    }

    // Security: only respond to the configured chat ID
    const incomingChatId = String(message.chat.id);
    if (incomingChatId !== TELEGRAM_CHAT_ID) {
      log(`⚠ Telegram command from unauthorized chat: ${incomingChatId}`);
      return res.sendStatus(200);
    }

    const reply = await handleTelegramCommand(message.text, incomingChatId);

    // Send reply
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: incomingChatId,
        text: reply,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    log(`Telegram command handler error: ${err.message}`);
  }
  res.sendStatus(200);
});

// ── Register Telegram Webhook on startup ─────────────────────────────────
async function registerTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN) return;
  const renderUrl = process.env.RENDER_EXTERNAL_URL || 'https://signal-bot-router.onrender.com';
  const webhookUrl = `${renderUrl}/telegram`;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const json = await resp.json();
    log(`Telegram webhook registered: ${webhookUrl} — ${json.ok ? '✅' : '❌ ' + json.description}`);
  } catch (err) {
    log(`Telegram webhook registration failed: ${err.message}`);
  }
}

// ── Startup State Recovery (v3.2.8) ─────────────────────────────────────
// After a deploy or Render restart, ACTIVE_BOTS is empty — all running
// positions lose revalidation protection. This function queries Gainium
// for open bots with active deals and rebuilds in-memory state so
// revalidation starts protecting them immediately.

async function recoverActiveState() {
  if (!gainiumApi.isConfigured()) {
    log(`🔄 Startup recovery: skipped — Gainium API not configured`);
    return;
  }

  try {
    // Step 1: Query exchange positions via Gainium (Gainium reads Binance directly)
    log(`🔄 Startup recovery: querying exchange positions via Gainium...`);
    let exchangePositions = new Map();
    try {
      exchangePositions = await gainiumApi.getExchangePositionMap();
      log(`🔄 Startup recovery: exchange reports ${exchangePositions.size} open position(s)`);
    } catch (err) {
      log(`🔄 Startup recovery: exchange position query failed — ${err.message}`);
    }

    // Step 2: Query Gainium for bot states
    log(`🔄 Startup recovery: querying Gainium for active bots...`);
    const botStatuses = await gainiumApi.getAllBotStatuses();
    if (!botStatuses) {
      log(`🔄 Startup recovery: Gainium API call failed — will rely on incoming signals`);
      return;
    }

    const recovered = [];
    const warnings = [];

    for (const [uuid, botInfo] of Object.entries(BOT_MAP)) {
      const status = botStatuses.get(uuid);
      if (!status) continue;

      // v3.5.0: Recover any bot with active deals, regardless of bot status.
      // Previously only recovered status='open' — missed 'closed' bots with
      // orphaned deals still running on Binance. Those positions ran blind
      // (no revalidation, no drawdown protection) until TP/SL hit.
      if (!status.deals || status.deals.active === 0) continue;

      // Parse direction and pair from bot name
      const direction = botInfo.name.toLowerCase().includes('long') ? 'LONG' :
                        botInfo.name.toLowerCase().includes('short') ? 'SHORT' : null;
      if (!direction) continue;

      const pair = botInfo.name.split(' ')[0].toUpperCase();

      // Cross-reference with exchange position data (via Gainium deals)
      const exchangePos = exchangePositions.get(pair);
      let entryPrice = null;
      let pnl = null;

      if (exchangePos) {
        entryPrice = exchangePos.entryPrice;
        pnl = exchangePos.pnl;

        // Warn if bot direction doesn't match deal direction
        if (exchangePos.side !== direction) {
          const msg = `⚠️ ${pair}: Bot says ${direction} but exchange deal is ${exchangePos.side}`;
          log(`🔄 Startup recovery: ${msg}`);
          warnings.push(msg);
        }
      }

      // Populate trackers
      // v3.5.2: Backdate startedAt so reval's 3-min grace period doesn't
      // delay checking recovered positions. Also set recovery lock so
      // incoming signals don't try to flip ghost deals before reval verifies.
      ACTIVE_BOTS[uuid] = {
        pair,
        direction,
        botName: botInfo.name,
        startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        entryPrice,
        origin: 'recovery',
      };
      LAST_ACTIVE[pair] = Date.now();
      LAST_DIRECTION[pair] = direction;
      RECOVERY_LOCK[pair] = Date.now() + RECOVERY_LOCK_MS;

      const priceStr = entryPrice ? `$${entryPrice.toFixed(2)}` : '?';
      const pnlStr = pnl !== null ? ` PnL $${pnl.toFixed(2)}` : '';
      recovered.push(`${botInfo.name} (${direction}, entry ${priceStr}${pnlStr})`);
    }

    // v3.6.0: Detect conflicting positions — both Long and Short active on same pair.
    // This is a position conflict that should never happen normally. Alert immediately.
    const recoveredPairs = {};
    for (const [uuid, botInfo] of Object.entries(ACTIVE_BOTS)) {
      const pair = botInfo.pair;
      if (!recoveredPairs[pair]) {
        recoveredPairs[pair] = [botInfo];
      } else {
        recoveredPairs[pair].push(botInfo);
      }
    }
    for (const [pair, bots] of Object.entries(recoveredPairs)) {
      if (bots.length > 1) {
        const dirs = bots.map(b => b.direction).join(' + ');
        const msg = `🚨 POSITION CONFLICT: ${pair} has ${bots.length} bots tracked (${dirs}) — both Long and Short active simultaneously!`;
        log(`🔄 Startup recovery: ${msg}`);
        warnings.push(msg);
      }
    }

    // Step 3: Detect orphaned exchange positions (deal exists but no bot in BOT_MAP)
    for (const [pair, pos] of exchangePositions) {
      const hasBot = Object.values(ACTIVE_BOTS).some(b => b.pair === pair);
      if (!hasBot) {
        const msg = `🚨 ${pair}: Exchange has a ${pos.side} position ($${pos.pnl.toFixed(2)} PnL) but NO tracked bot is running`;
        log(`🔄 Startup recovery: ${msg}`);
        warnings.push(msg);
      }
    }

    // Step 4: Send Telegram summary
    if (recovered.length > 0 || warnings.length > 0) {
      const parts = [`🔄 Startup recovery\n\nServer restarted.`];

      if (recovered.length > 0) {
        parts.push(`Recovered ${recovered.length} active position(s):\n`);
        parts.push(recovered.map(r => `• ${r}`).join('\n'));
        parts.push(`\nRevalidation is now protecting these positions.`);
      }

      if (warnings.length > 0) {
        parts.push(`\n⚠️ Discrepancies detected:\n`);
        parts.push(warnings.join('\n'));
      }

      parts.push(`\n${istTimestamp()}`);
      const msg = parts.join('\n');

      log(`🔄 Startup recovery: ✅ recovered ${recovered.length} bot(s), ${warnings.length} warning(s)`);
      sendTelegramAlert(msg).catch(() => {});
    } else {
      log(`🔄 Startup recovery: no active bots found — system is flat`);
      sendTelegramAlert(
        `🔄 Startup recovery\n\n` +
        `Server restarted. No active positions found on Gainium — system is flat.\n\n` +
        `${istTimestamp()}`
      ).catch(() => {});
    }
  } catch (err) {
    log(`🔄 Startup recovery: error: ${err.message}`);
  }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  log(`🚀 Signal Bot Router v${VERSION} listening on port ${PORT}`);
  log(`   Webhook endpoint: POST /webhook`);
  log(`   Telegram commands: POST /telegram`);
  log(`   Health check: GET /`);
  log(`   Gainium target: ${GAINIUM_WEBHOOK_URL}`);
  log(`   API verification: ${gainiumApi.isConfigured() ? '✅ configured' : '⚠ NOT configured (set GAINIUM_API_KEY + GAINIUM_API_SECRET)'}`);
  log(`   Telegram alerts: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? '✅ configured' : '⚠ NOT configured (optional)'}`);
  log(`   Signal timeframe: 1H (v3.7.0 — migrated from 4H for faster entries)`);
  log(`   Cold-start scan: ✅ enabled (v3.8.0 — detects existing trends on startup)`);
  log(`   Gate 1 (Daily EMA50): ADVISORY (demoted v3.6.3 — logged, not blocking)`);
  log(`   Periodic re-validation: every ${REVAL_INTERVAL / 1000}s (fail-closed, ${REVAL_GRACE_PERIOD_MS / 60000}min grace, ${REVAL_MAX_DRAWDOWN_PCT}% drawdown limit, ${REVAL_MAX_UNDERWATER_MS / (60 * 60 * 1000)}h max underwater, ${signalGate.CONFIG.shortTermEma.minRevalSpreadPct}% EMA spread)`);
  log(`   Known bots: ${Object.keys(BOT_MAP).length}`);

  // v3.2.8: Recover active state BEFORE revalidation or self-heal run
  await recoverActiveState();

  // Register Telegram webhook after server is listening
  registerTelegramWebhook();
});
