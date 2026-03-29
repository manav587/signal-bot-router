const express = require('express');
const app = express();

// Parse both JSON and plain text bodies (TradingView sends text/plain when message has emoji prefix)
app.use(express.json());
app.use(express.text({ type: '*/*' }));

const GAINIUM_WEBHOOK_URL = 'https://api.gainium.io/trade_signal';

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

// Send a single action to Gainium's webhook endpoint
async function sendAction(action) {
  const response = await fetch(GAINIUM_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([action]),
  });
  return response.status;
}

// Process actions sequentially with delays
async function processActions(actions, requestId) {
  log(`[${requestId}] Processing ${actions.length} action(s)...`);

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const actionName = action.action || 'unknown';
    const uuid = action.uuid || 'no-uuid';
    const shortUuid = uuid.substring(0, 8);

    log(`[${requestId}]   ${i + 1}/${actions.length}: ${actionName} → ${shortUuid}...`);

    try {
      const status = await sendAction(action);
      log(`[${requestId}]   ✓ ${actionName} returned ${status}`);
    } catch (err) {
      log(`[${requestId}]   ✗ ${actionName} FAILED: ${err.message}`);
      // Continue with remaining actions — don't let one failure block the rest
    }

    // Apply delay AFTER the action (gives Binance time to process)
    const delayMs = DELAYS[actionName] || 1000;
    if (delayMs > 0 && i < actions.length - 1) {
      log(`[${requestId}]   ⏳ Waiting ${delayMs / 1000}s before next action...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  log(`[${requestId}] ✅ All ${actions.length} action(s) completed`);
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Signal Bot Router',
    status: 'running',
    uptime: Math.floor(process.uptime()) + 's',
    version: '1.0.0',
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

  // Process in background (don't block the response)
  processActions(actions, requestId).catch(err => {
    log(`[${requestId}] ❌ Unexpected error: ${err.message}`);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`🚀 Signal Bot Router v1.0.0 listening on port ${PORT}`);
  log(`   Webhook endpoint: POST /webhook`);
  log(`   Health check: GET /`);
  log(`   Gainium target: ${GAINIUM_WEBHOOK_URL}`);
});
