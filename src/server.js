const express = require('express');
const app = express();
const gainiumApi = require('./gainium-api');

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
  startBot:      0,     // No delay needed after start
  startDeal:     0,
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

  const result = await gainiumApi.verifyAndForceClose(targetBot.uuid, targetBot.name);

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
    status: 'running',
    uptime: Math.floor(process.uptime()) + 's',
    version: '1.3.1',
    apiConfigured: gainiumApi.isConfigured(),
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
  });
});

// Test endpoint — raw diagnostic: shows exact HTTP response from Gainium REST API
app.get('/test-verify/:uuid', async (req, res) => {
  const uuid = req.params.uuid;
  const bot = BOT_MAP[uuid];
  if (!bot) {
    return res.status(404).json({ error: 'UUID not in BOT_MAP', uuid });
  }

  // Make the raw API call ourselves so we can capture everything
  const crypto = require('crypto');
  const apiKey = process.env.GAINIUM_API_KEY || '';
  const apiSecret = process.env.GAINIUM_API_SECRET || '';
  const endpoint = `/api/v2/bots/dca/${uuid}`;
  const url = `https://api.gainium.io${endpoint}?fields=_id,uuid,settings.name,deals`;
  const method = 'GET';
  const timestamp = Date.now().toString();
  const payload = `${method}${endpoint}${timestamp}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('base64');

  log(`[test-diag] Bot: ${bot.name}`);
  log(`[test-diag] URL: ${url}`);
  log(`[test-diag] Endpoint (signed): ${endpoint}`);
  log(`[test-diag] Payload (signed): ${payload}`);
  log(`[test-diag] API key length: ${apiKey.length}, Secret length: ${apiSecret.length}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'token': apiKey,
        'signature': signature,
        'time': timestamp,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();

    log(`[test-diag] Response: ${response.status} ${response.statusText}`);
    log(`[test-diag] Content-Type: ${contentType}`);
    log(`[test-diag] Body: ${body.substring(0, 500)}`);

    res.json({
      bot: bot.name,
      uuid,
      request: { url, endpoint, method, apiKeyLength: apiKey.length, secretLength: apiSecret.length },
      response: { status: response.status, statusText: response.statusText, contentType, body: body.substring(0, 500) },
    });
  } catch (err) {
    log(`[test-diag] Error: ${err.message}`);
    res.status(500).json({ bot: bot.name, uuid, error: err.message });
  }
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

  // Build a human-readable description for Telegram
  const botNames = actions
    .map(a => BOT_MAP[a.uuid]?.name || a.uuid?.substring(0, 8) || '?')
    .filter((v, i, arr) => arr.indexOf(v) === i); // dedupe
  const actionNames = actions.map(a => a.action).join(' → ');
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`🚀 Signal Bot Router v1.3.1 listening on port ${PORT}`);
  log(`   Webhook endpoint: POST /webhook`);
  log(`   Health check: GET /`);
  log(`   Gainium target: ${GAINIUM_WEBHOOK_URL}`);
  log(`   API verification: ${gainiumApi.isConfigured() ? '✅ configured' : '⚠ NOT configured (set GAINIUM_API_KEY + GAINIUM_API_SECRET)'}`);
  log(`   Telegram alerts: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? '✅ configured' : '⚠ NOT configured (optional)'}`);
  log(`   Known bots: ${Object.keys(BOT_MAP).length}`);
});
