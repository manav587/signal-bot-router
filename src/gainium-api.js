/**
 * Gainium REST API v2 Client
 * Used by Signal Bot Router v1.2.0 for deal verification and force-close.
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

function authHeaders(method, endpoint, body = '') {
  const timestamp = Date.now().toString();
  const signature = sign(body, method.toUpperCase(), endpoint, timestamp);
  return {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    'x-api-sign': signature,
    'x-api-timestamp': timestamp,
  };
}

// ── API Calls ────────────────────────────────────────────────────────────

/**
 * GET a bot's deal count to check if any deals are still active.
 * Returns { active: number, all: number } or null on error.
 * @param {string} botId — Bot UUID (NOT MongoDB ObjectId — API returns 404 for ObjectIds)
 */
async function getBotDeals(botId) {
  const endpoint = `/api/v2/bots/dca/${botId}`;
  const url = `${BASE_URL}${endpoint}?fields=_id,uuid,settings.name,deals`;
  const method = 'GET';
  const headers = authHeaders(method, endpoint);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, { method, headers, signal: controller.signal });
    clearTimeout(timeout);

    // Handle non-JSON responses (e.g. Gainium returning "Not found" as plain text)
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      log(`getBotDeals non-JSON response (${res.status}): ${text.substring(0, 200)}`);
      return null;
    }

    const json = await res.json();
    if (json.status === 'OK' && json.data) {
      return json.data.deals; // { active: N, all: N }
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
 * Returns array of { _id, status, pair } or empty array on error.
 */
async function listOpenDeals(botId) {
  const endpoint = `/api/v2/deals/dca`;
  const query = `?botId=${botId}&status=open&fields=_id,status,pair`;
  const url = `${BASE_URL}${endpoint}${query}`;
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
    if (json.status === 'OK' && Array.isArray(json.data)) {
      return json.data;
    }
    log(`listOpenDeals unexpected response: ${JSON.stringify(json).substring(0, 300)}`);
    return [];
  } catch (err) {
    log(`listOpenDeals error for bot ${botId}: ${err.message}`);
    return [];
  }
}

/**
 * Force-close a single deal by market.
 * Returns true on success, false on failure.
 */
async function forceCloseDeal(dealId) {
  const endpoint = `/api/v2/deals/manage`;
  const method = 'POST';
  const bodyObj = {
    action: 'close',
    dealId,
    dealType: 'dca',
    closeType: 'closeByMarket',
  };
  const body = JSON.stringify(bodyObj);
  const headers = authHeaders(method, endpoint, body);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // longer timeout for close

    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      log(`forceCloseDeal non-JSON response (${res.status}): ${text.substring(0, 200)}`);
      return false;
    }

    const json = await res.json();
    if (json.status === 'OK') {
      log(`forceCloseDeal: deal ${dealId} closed successfully`);
      return true;
    }
    log(`forceCloseDeal: deal ${dealId} returned: ${JSON.stringify(json).substring(0, 300)}`);
    return false;
  } catch (err) {
    log(`forceCloseDeal error for ${dealId}: ${err.message}`);
    return false;
  }
}

// ── Composite: Verify Flat Book ──────────────────────────────────────────

/**
 * Read bot deals with exponential backoff retry.
 * Retries on null (API unreachable) with delays: 3s → 6s → 12s.
 *
 * @param {string} botMongoId — Gainium MongoDB ObjectId
 * @param {string} botName    — Human-readable name (for logging)
 * @param {number} maxAttempts — Number of attempts (default 4)
 * @returns {object|null} — deals object or null if all attempts fail
 */
async function getBotDealsWithBackoff(botMongoId, botName, maxAttempts = 4) {
  const backoffMs = [0, 3000, 6000, 12000]; // first attempt immediate, then 3s, 6s, 12s

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      const delay = backoffMs[i] || backoffMs[backoffMs.length - 1];
      log(`[${botName}] API read failed — retrying in ${delay / 1000}s (attempt ${i + 1}/${maxAttempts})...`);
      await new Promise(r => setTimeout(r, delay));
    }

    const deals = await getBotDeals(botMongoId);
    if (deals) return deals;
  }

  log(`[${botName}] ❌ All ${maxAttempts} API read attempts failed`);
  return null;
}

/**
 * Verify that a bot has zero active deals. If deals remain, force-close them.
 *
 * @param {string} botMongoId — Gainium MongoDB ObjectId for the bot
 * @param {string} botName    — Human-readable name (for logging)
 * @param {number} maxRetries — How many verify-then-close cycles (default 2)
 * @returns {{ flat: boolean, forceClosed: number, error: string|null }}
 */
async function verifyAndForceClose(botMongoId, botName, maxRetries = 2) {
  let totalForceClosed = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`[${botName}] Verify attempt ${attempt}/${maxRetries}: checking deals.active...`);

    const deals = await getBotDealsWithBackoff(botMongoId, botName);
    if (!deals) {
      return { flat: false, forceClosed: totalForceClosed, error: 'Failed to read bot state from Gainium API (all retries exhausted)' };
    }

    if (deals.active === 0) {
      log(`[${botName}] ✅ Confirmed flat — deals.active = 0`);
      return { flat: true, forceClosed: totalForceClosed, error: null };
    }

    log(`[${botName}] ⚠ deals.active = ${deals.active} — fetching open deal IDs...`);

    const openDeals = await listOpenDeals(botMongoId);
    if (openDeals.length === 0) {
      // API says active > 0 but no open deals returned — possible lag
      log(`[${botName}] Mismatch: deals.active=${deals.active} but listOpenDeals returned 0. Waiting 3s...`);
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    // Force-close each open deal
    for (const deal of openDeals) {
      log(`[${botName}] Force-closing deal ${deal._id} (${deal.pair || 'unknown pair'})...`);
      const closed = await forceCloseDeal(deal._id);
      if (closed) totalForceClosed++;
    }

    // Wait for Binance to process the close
    log(`[${botName}] Waiting 5s for Binance to settle after force-close...`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // Final check after all retries (also with backoff)
  const finalDeals = await getBotDealsWithBackoff(botMongoId, botName);
  if (finalDeals && finalDeals.active === 0) {
    log(`[${botName}] ✅ Confirmed flat after force-close — deals.active = 0`);
    return { flat: true, forceClosed: totalForceClosed, error: null };
  }

  const msg = `CRITICAL: ${botName} still has ${finalDeals ? finalDeals.active : '?'} active deal(s) after ${maxRetries} force-close attempts`;
  log(`[${botName}] ❌ ${msg}`);
  return { flat: false, forceClosed: totalForceClosed, error: msg };
}

// ── Public API ───────────────────────────────────────────────────────────

function isConfigured() {
  return API_KEY.length > 0 && API_SECRET.length > 0;
}

module.exports = {
  isConfigured,
  getBotDeals,
  listOpenDeals,
  forceCloseDeal,
  verifyAndForceClose,
};
