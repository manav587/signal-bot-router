/**
 * Gainium REST API v1 Client
 * Used by Signal Bot Router for deal verification and force-close.
 *
 * Auth: HMAC-SHA256 signing per Gainium docs:
 *   signature = HMAC-SHA256(secret, body + method + endpoint + timestamp)
 *
 * Env vars required:
 *   GAINIUM_API_KEY    — from Gainium dashboard (needs Write permission)
 *   GAINIUM_API_SECRET — the HMAC secret paired with the key
 */

const crypto = require('crypto');

const BASE_URL = 'https://api.gainium.io';
const API_KEY = process.env.GAINIUM_API_KEY || '';
const API_SECRET = process.env.GAINIUM_API_SECRET || '';

// ── Logging (uses same IST format as server.js) ──────────────────────────

function istTimestamp() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function log(msg) {
  console.log(`[${istTimestamp()}] [gainium-api] ${msg}`);
}

// ── HMAC Signing ─────────────────────────────────────────────────────────

function sign(body, method, endpoint, timestamp) {
  const payload = `${body}${method}${endpoint}${timestamp}`;
  return crypto.createHmac('sha256', API_SECRET).update(payload).digest('base64');
}

/**
 * Build HMAC auth headers.
 * IMPORTANT: endpoint must include query string if present (e.g. '/api/deals?status=open')
 * because Gainium verifies the signature against the full endpoint path.
 */
function authHeaders(method, endpoint, body = '') {
  const timestamp = Date.now().toString();
  const signature = sign(body, method.toUpperCase(), endpoint, timestamp);
  return {
    'Content-Type': 'application/json',
    'token': API_KEY,
    'signature': signature,
    'time': timestamp,
  };
}

// ── API Calls ────────────────────────────────────────────────────────────

/**
 * GET a bot's deal count to check if any deals are still active.
 * Returns { active: number, all: number } or null on error.
 * @param {string} botId — Bot UUID (NOT MongoDB ObjectId — API returns 404 for ObjectIds)
 */
async function getBotDeals(botId) {
  // V1 endpoint — V2 returns 401 with current API key
  const endpoint = `/api/bots/dca`;
  const url = `${BASE_URL}${endpoint}`;
  const method = 'GET';
  const headers = authHeaders(method, endpoint);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, { method, headers, signal: controller.signal });
    clearTimeout(timeout);

    // Handle non-JSON responses
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      log(`getBotDeals non-JSON response (${res.status}): ${text.substring(0, 200)}`);
      return null;
    }

    const json = await res.json();
    // V1 returns { data: { result: [...bots...] } }
    if (json.status === 'OK' && json.data && json.data.result) {
      const bot = json.data.result.find(b => b.uuid === botId || b._id === botId);
      if (!bot) {
        log(`getBotDeals: bot ${botId} not found in ${json.data.result.length} bots`);
        return null;
      }
      return bot.deals; // { active: N, all: N }
    }
    log(`getBotDeals unexpected response: ${JSON.stringify(json).substring(0, 300)}`);
    return null;
  } catch (err) {
    log(`getBotDeals error for ${botId}: ${err.message}`);
    return null;
  }
}

/**
 * List open deals for a specific bot.
 * V1 endpoint with status=open filter — query params must be included in HMAC signature.
 * NOTE: V1 deals use MongoDB ObjectId in botId field, NOT UUID.
 * Returns array of { _id, status, pair, botId } or empty array on error.
 */
async function listOpenDeals(botMongoId) {
  // V1 endpoint with status filter — query params MUST be in the signed endpoint
  const endpoint = `/api/deals?status=open`;
  const url = `${BASE_URL}${endpoint}`;
  const method = 'GET';
  const headers = authHeaders(method, endpoint);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, { method, headers, signal: controller.signal });
    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      log(`listOpenDeals non-JSON response (${res.status}): ${text.substring(0, 200)}`);
      return [];
    }

    const json = await res.json();
    // V1 returns { data: { page, totalPages, totalResults, result: [...] } }
    if (json.status === 'OK' && json.data && Array.isArray(json.data.result)) {
      const openDeals = json.data.result.filter(d => d.botId === botMongoId);
      log(`listOpenDeals: found ${openDeals.length} open deal(s) for bot ${botMongoId} (out of ${json.data.result.length} total open)`);
      return openDeals;
    }
    log(`listOpenDeals unexpected response: ${JSON.stringify(json).substring(0, 300)}`);
    return [];
  } catch (err) {
    log(`listOpenDeals error for bot ${botMongoId}: ${err.message}`);
    return [];
  }
}

/**
 * Force-close all deals for a bot via the webhook endpoint (closeAllDeals).
 * The V1 REST DELETE /api/closeDeal/{dealId} returns 400 "Missed required paramas"
 * with every body format tried — the required params are undocumented.
 * The webhook closeAllDeals is the proven, reliable close mechanism.
 *
 * @param {string} botUuid — Bot UUID (webhook uses UUIDs, not MongoDB IDs)
 * @returns {boolean} — true if webhook returned 200
 */
async function forceCloseDeals(botUuid) {
  const webhookUrl = 'https://api.gainium.io/trade_signal';
  const payload = [{ action: 'closeAllDeals', uuid: botUuid }];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      log(`forceCloseDeals: closeAllDeals webhook sent for bot ${botUuid} — status ${res.status}`);
      return true;
    }
    log(`forceCloseDeals: webhook returned ${res.status} for bot ${botUuid}`);
    return false;
  } catch (err) {
    log(`forceCloseDeals error for ${botUuid}: ${err.message}`);
    return false;
  }
}

// ── Composite: Verify Flat Book ──────────────────────────────────────────

/**
 * Read bot deals with exponential backoff retry.
 * Retries on null (API unreachable) with delays: 3s → 6s → 12s.
 *
 * @param {string} botUuid    — Gainium bot UUID
 * @param {string} botName    — Human-readable name (for logging)
 * @param {number} maxAttempts — Number of attempts (default 4)
 * @returns {object|null} — deals object or null if all attempts fail
 */
async function getBotDealsWithBackoff(botUuid, botName, maxAttempts = 4) {
  const backoffMs = [0, 3000, 6000, 12000]; // first attempt immediate, then 3s, 6s, 12s

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      const delay = backoffMs[i] || backoffMs[backoffMs.length - 1];
      log(`[${botName}] API read failed — retrying in ${delay / 1000}s (attempt ${i + 1}/${maxAttempts})...`);
      await new Promise(r => setTimeout(r, delay));
    }

    const deals = await getBotDeals(botUuid);
    if (deals) return deals;
  }

  log(`[${botName}] ❌ All ${maxAttempts} API read attempts failed`);
  return null;
}

/**
 * Verify that a bot has zero active deals. If deals remain, force-close them.
 *
 * @param {string} botUuid    — Gainium bot UUID (for getBotDeals)
 * @param {string} botMongoId — Gainium MongoDB ObjectId (for listOpenDeals — deals use mongoId, not UUID)
 * @param {string} botName    — Human-readable name (for logging)
 * @param {number} maxRetries — How many verify-then-close cycles (default 2)
 * @returns {{ flat: boolean, forceClosed: number, error: string|null }}
 */
async function verifyAndForceClose(botUuid, botMongoId, botName, maxRetries = 2) {
  let totalForceClosed = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`[${botName}] Verify attempt ${attempt}/${maxRetries}: checking deals.active...`);

    const deals = await getBotDealsWithBackoff(botUuid, botName);
    if (!deals) {
      return { flat: false, forceClosed: totalForceClosed, error: 'Failed to read bot state from Gainium API (all retries exhausted)' };
    }

    if (deals.active === 0) {
      log(`[${botName}] ✅ Confirmed flat — deals.active = 0`);
      return { flat: true, forceClosed: totalForceClosed, error: null };
    }

    log(`[${botName}] ⚠ deals.active = ${deals.active} — sending closeAllDeals webhook...`);

    const closed = await forceCloseDeals(botUuid);
    if (closed) {
      totalForceClosed++;
    } else {
      log(`[${botName}] closeAllDeals webhook failed — will retry on next attempt`);
    }

    // Wait for Binance to process the close
    log(`[${botName}] Waiting 5s for Binance to settle after force-close...`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // Final check after all retries (also with backoff)
  let finalDeals = await getBotDealsWithBackoff(botUuid, botName);
  if (finalDeals && finalDeals.active === 0) {
    log(`[${botName}] ✅ Confirmed flat after force-close — deals.active = 0`);
    return { flat: true, forceClosed: totalForceClosed, error: null };
  }

  // v3.2.8: REST API fallback — webhook closeAllDeals stalled, try individual deal close
  log(`[${botName}] ⚠ Webhook closeAllDeals stalled — attempting REST API close...`);
  const restResult = await closeDealsViaApi(botMongoId, botName);
  if (restResult.closed > 0) {
    totalForceClosed += restResult.closed;
    log(`[${botName}] REST fallback closed ${restResult.closed} deal(s) — waiting 5s for Binance...`);
    await new Promise(r => setTimeout(r, 5000));

    finalDeals = await getBotDealsWithBackoff(botUuid, botName);
    if (finalDeals && finalDeals.active === 0) {
      log(`[${botName}] ✅ Confirmed flat after REST fallback — deals.active = 0`);
      return { flat: true, forceClosed: totalForceClosed, error: null };
    }
  }

  const msg = `CRITICAL: ${botName} still has ${finalDeals ? finalDeals.active : '?'} active deal(s) after ${maxRetries} webhook + REST API attempts`;
  log(`[${botName}] ❌ ${msg}`);
  return { flat: false, forceClosed: totalForceClosed, error: msg };
}

/**
 * Get bot status and deal counts for ALL DCA bots in one API call.
 * Returns a Map of UUID → { status, deals: { active, all }, name }
 * Used by the self-heal monitor to detect orphaned pairs.
 */
async function getAllBotStatuses() {
  const endpoint = `/api/bots/dca`;
  const url = `${BASE_URL}${endpoint}`;
  const method = 'GET';
  const headers = authHeaders(method, endpoint);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, { method, headers, signal: controller.signal });
    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      log(`getAllBotStatuses non-JSON response (${res.status}): ${text.substring(0, 200)}`);
      return null;
    }

    const json = await res.json();
    if (json.status === 'OK' && json.data && json.data.result) {
      const statusMap = new Map();
      for (const bot of json.data.result) {
        const key = bot.uuid || bot._id;
        statusMap.set(key, {
          status: bot.status,
          deals: bot.deals || { active: 0, all: 0 },
          name: bot.settings?.name || bot.name || key,
        });
      }
      log(`getAllBotStatuses: fetched ${statusMap.size} bot(s)`);
      return statusMap;
    }
    log(`getAllBotStatuses unexpected response: ${JSON.stringify(json).substring(0, 300)}`);
    return null;
  } catch (err) {
    log(`getAllBotStatuses error: ${err.message}`);
    return null;
  }
}

// ── REST API Deal Close (v3.2.8 — fallback when webhook closeAllDeals stalls) ──

/**
 * Close individual deals via the REST API instead of the webhook.
 * Proven to work (Gainium MCP manage_deal uses the same path).
 * Called as a fallback when webhook closeAllDeals fails to achieve flat.
 *
 * @param {string} botMongoId — MongoDB ObjectId of the bot
 * @param {string} botName    — Human-readable name (for logging)
 * @returns {{ closed: number, failed: number }}
 */
async function closeDealsViaApi(botMongoId, botName) {
  try {
    const deals = await listOpenDeals(botMongoId);
    if (!deals || deals.length === 0) {
      log(`[${botName}] REST close: no open deals found`);
      return { closed: 0, failed: 0 };
    }

    let closed = 0, failed = 0;
    for (const deal of deals) {
      const dealId = deal._id;
      // POST to /api/deals/{dealId}/manage with close action
      const endpoint = `/api/deals/${dealId}/manage`;
      const body = JSON.stringify({ action: 'close', closeType: 'cancel', dealType: 'dca' });
      const method = 'POST';
      const url = `${BASE_URL}${endpoint}`;
      const headers = authHeaders(method, endpoint, body);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(url, { method, headers, body, signal: controller.signal });
        clearTimeout(timeout);

        const contentType = res.headers.get('content-type') || '';
        let responseBody = '';
        if (contentType.includes('application/json')) {
          const json = await res.json();
          responseBody = JSON.stringify(json).substring(0, 200);
        }

        if (res.ok) {
          log(`[${botName}] REST close succeeded for deal ${dealId} (${res.status})`);
          closed++;
        } else {
          log(`[${botName}] REST close returned ${res.status} for deal ${dealId}: ${responseBody}`);
          failed++;
        }
      } catch (dealErr) {
        log(`[${botName}] REST close error for deal ${dealId}: ${dealErr.message}`);
        failed++;
      }

      // Brief pause between deals
      if (deals.length > 1) await new Promise(r => setTimeout(r, 1000));
    }

    log(`[${botName}] REST API close: ${closed} succeeded, ${failed} failed out of ${deals.length} deal(s)`);
    return { closed, failed };
  } catch (err) {
    log(`[${botName}] closeDealsViaApi error: ${err.message}`);
    return { closed: 0, failed: 0 };
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * List ALL open deals (unfiltered). Single API call.
 * Used by Telegram /positions command.
 */
async function listAllOpenDeals() {
  const endpoint = `/api/deals?status=open`;
  const url = `${BASE_URL}${endpoint}`;
  const method = 'GET';
  const headers = authHeaders(method, endpoint);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, { method, headers, signal: controller.signal });
    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      log(`listAllOpenDeals non-JSON response (${res.status}): ${text.substring(0, 200)}`);
      return [];
    }

    const json = await res.json();
    if (json.status === 'OK' && json.data && Array.isArray(json.data.result)) {
      log(`listAllOpenDeals: found ${json.data.result.length} total open deal(s)`);
      return json.data.result;
    }
    log(`listAllOpenDeals unexpected response: ${JSON.stringify(json).substring(0, 300)}`);
    return [];
  } catch (err) {
    log(`listAllOpenDeals error: ${err.message}`);
    return [];
  }
}

function isConfigured() {
  return API_KEY.length > 0 && API_SECRET.length > 0;
}

module.exports = {
  isConfigured,
  getBotDeals,
  getAllBotStatuses,
  listOpenDeals,
  listAllOpenDeals,
  forceCloseDeals,
  closeDealsViaApi,
  verifyAndForceClose,
};
