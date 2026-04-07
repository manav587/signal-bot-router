/**
 * Trade Journal (v3.6.0)
 *
 * In-memory trade log with daily P&L summaries.
 * Records every entry, exit, gate decision, and outcome.
 * Exposes data via Telegram commands (/trades, /journal).
 * Sends a daily P&L summary to Telegram at a configured hour.
 *
 * Persistence: In-memory only (resets on deploy). Daily summaries
 * are sent to Telegram so the data survives in chat history.
 * Future: Google Sheet integration for permanent storage.
 */

// ── Trade Records ────────────────────────────────────────────────────────
// Each trade is logged from entry to exit as a single record.
// Active trades have exitTime = null until closed.

const trades = [];       // Complete trade history (this deploy)
const dailyStats = {};   // Key = 'YYYY-MM-DD', Value = { wins, losses, totalPnl, trades: [] }

// ── Logging ──────────────────────────────────────────────────────────────

function istTimestamp() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function log(msg) {
  console.log(`[${istTimestamp()}] [journal] ${msg}`);
}

function todayIST() {
  // Get current date in IST
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
}

// ── Record Entry ─────────────────────────────────────────────────────────

/**
 * Record a trade entry.
 * Called when processActions completes successfully with a startBot action.
 *
 * @param {object} params
 * @param {string} params.pair - e.g. 'SOL'
 * @param {string} params.direction - 'LONG' or 'SHORT'
 * @param {string} params.botName - e.g. 'SOL Long v2'
 * @param {string} params.botUuid - Bot UUID
 * @param {number} params.entryPrice - Entry price
 * @param {string} params.origin - 'signal', 'auto-flip', 'funding', 'self-heal'
 * @param {object} params.gateData - Gate decision data at entry time
 * @returns {string} tradeId
 */
function recordEntry(params) {
  const tradeId = `${params.pair}-${Date.now()}`;
  const trade = {
    id: tradeId,
    pair: params.pair,
    direction: params.direction,
    botName: params.botName,
    botUuid: params.botUuid,
    entryPrice: params.entryPrice,
    entryTime: new Date().toISOString(),
    exitPrice: null,
    exitTime: null,
    exitReason: null,    // 'reval-flip', 'drawdown', 'gate-stop', 'manual', 'tp', 'sl'
    pnl: null,
    pnlPct: null,
    origin: params.origin,
    gateData: params.gateData || {},
    durationMs: null,
  };

  trades.push(trade);
  log(`📝 Entry: ${trade.pair} ${trade.direction} @ $${trade.entryPrice?.toFixed(2) || '?'} (${trade.origin}) [${tradeId}]`);
  return tradeId;
}

// ── Record Exit ──────────────────────────────────────────────────────────

/**
 * Record a trade exit. Finds the active trade for this bot and closes it.
 *
 * @param {object} params
 * @param {string} params.botUuid - Bot UUID (matches the active trade)
 * @param {number} params.exitPrice - Exit price
 * @param {string} params.exitReason - Why the trade was closed
 * @returns {object|null} The closed trade record, or null if no active trade found
 */
function recordExit(params) {
  // Find the most recent active trade for this bot
  const trade = [...trades].reverse().find(t =>
    t.botUuid === params.botUuid && t.exitTime === null
  );

  if (!trade) {
    log(`📝 Exit: no active trade found for bot ${params.botUuid?.substring(0, 8)} — skipping journal entry`);
    return null;
  }

  trade.exitPrice = params.exitPrice;
  trade.exitTime = new Date().toISOString();
  trade.exitReason = params.exitReason;
  trade.durationMs = new Date(trade.exitTime).getTime() - new Date(trade.entryTime).getTime();

  // Calculate P&L
  if (trade.entryPrice && trade.exitPrice) {
    if (trade.direction === 'LONG') {
      trade.pnlPct = ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
    } else {
      trade.pnlPct = ((trade.entryPrice - trade.exitPrice) / trade.entryPrice) * 100;
    }
    trade.pnlPct = parseFloat(trade.pnlPct.toFixed(3));
  }

  // Update daily stats
  const day = todayIST();
  if (!dailyStats[day]) {
    dailyStats[day] = { wins: 0, losses: 0, totalPnlPct: 0, trades: [] };
  }
  dailyStats[day].trades.push(trade.id);
  if (trade.pnlPct !== null) {
    dailyStats[day].totalPnlPct += trade.pnlPct;
    if (trade.pnlPct >= 0) {
      dailyStats[day].wins++;
    } else {
      dailyStats[day].losses++;
    }
  }

  const durationMin = Math.round(trade.durationMs / 60000);
  log(`📝 Exit: ${trade.pair} ${trade.direction} @ $${trade.exitPrice?.toFixed(2) || '?'} — ${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct?.toFixed(2) || '?'}% (${trade.exitReason}, ${durationMin}min) [${trade.id}]`);

  return trade;
}

// ── Query Functions ──────────────────────────────────────────────────────

/**
 * Get all active (open) trades.
 */
function getActiveTrades() {
  return trades.filter(t => t.exitTime === null);
}

/**
 * Get closed trades for today (IST).
 */
function getTodayTrades() {
  const day = todayIST();
  const dayStart = new Date(day + 'T00:00:00+05:30');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  return trades.filter(t =>
    t.exitTime &&
    new Date(t.exitTime) >= dayStart &&
    new Date(t.exitTime) < dayEnd
  );
}

/**
 * Get daily stats for today.
 */
function getTodayStats() {
  const day = todayIST();
  return dailyStats[day] || { wins: 0, losses: 0, totalPnlPct: 0, trades: [] };
}

/**
 * Get all daily stats (for multi-day view).
 */
function getAllDailyStats() {
  return dailyStats;
}

/**
 * Get total stats since last deploy.
 */
function getSessionStats() {
  const closed = trades.filter(t => t.exitTime !== null);
  const wins = closed.filter(t => t.pnlPct >= 0).length;
  const losses = closed.filter(t => t.pnlPct < 0).length;
  const totalPnlPct = closed.reduce((sum, t) => sum + (t.pnlPct || 0), 0);
  const avgWin = wins > 0 ? closed.filter(t => t.pnlPct >= 0).reduce((s, t) => s + t.pnlPct, 0) / wins : 0;
  const avgLoss = losses > 0 ? closed.filter(t => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0) / losses : 0;

  // Per-pair breakdown
  const byPair = {};
  for (const t of closed) {
    if (!byPair[t.pair]) byPair[t.pair] = { wins: 0, losses: 0, totalPnlPct: 0, trades: 0 };
    byPair[t.pair].trades++;
    byPair[t.pair].totalPnlPct += t.pnlPct || 0;
    if (t.pnlPct >= 0) byPair[t.pair].wins++;
    else byPair[t.pair].losses++;
  }

  // Per-origin breakdown
  const byOrigin = {};
  for (const t of closed) {
    if (!byOrigin[t.origin]) byOrigin[t.origin] = { count: 0, pnlPct: 0 };
    byOrigin[t.origin].count++;
    byOrigin[t.origin].pnlPct += t.pnlPct || 0;
  }

  return {
    totalTrades: closed.length,
    activeTrades: trades.filter(t => !t.exitTime).length,
    wins,
    losses,
    winRate: closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) + '%' : 'N/A',
    totalPnlPct: parseFloat(totalPnlPct.toFixed(3)),
    avgWinPct: parseFloat(avgWin.toFixed(3)),
    avgLossPct: parseFloat(avgLoss.toFixed(3)),
    byPair,
    byOrigin,
  };
}

// ── Telegram Formatters ──────────────────────────────────────────────────

/**
 * Format for /trades command — shows active trades + today's closed.
 */
function formatTradesSummary() {
  const active = getActiveTrades();
  const todayClosed = getTodayTrades();
  const stats = getTodayStats();

  let lines = ['📒 <b>Trade Journal</b>\n'];

  if (active.length > 0) {
    lines.push('<b>Open Trades:</b>');
    for (const t of active) {
      const ageMin = Math.round((Date.now() - new Date(t.entryTime).getTime()) / 60000);
      lines.push(`  ${t.pair} ${t.direction} @ $${t.entryPrice?.toFixed(2) || '?'} — ${ageMin}min (${t.origin})`);
    }
    lines.push('');
  } else {
    lines.push('No open trades.\n');
  }

  if (todayClosed.length > 0) {
    lines.push(`<b>Today's Closed (${todayClosed.length}):</b>`);
    for (const t of todayClosed) {
      const emoji = t.pnlPct >= 0 ? '✅' : '❌';
      const durationMin = Math.round(t.durationMs / 60000);
      lines.push(`  ${emoji} ${t.pair} ${t.direction}: ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct?.toFixed(2) || '?'}% — ${t.exitReason} (${durationMin}min)`);
    }
    lines.push('');
    lines.push(`Today: ${stats.wins}W / ${stats.losses}L — net ${stats.totalPnlPct >= 0 ? '+' : ''}${stats.totalPnlPct.toFixed(2)}%`);
  } else {
    lines.push('No closed trades today.');
  }

  lines.push(`\n${istTimestamp()} IST`);
  return lines.join('\n');
}

/**
 * Format for /journal command — full session stats.
 */
function formatJournalSummary() {
  const stats = getSessionStats();

  let lines = ['📊 <b>Session Journal</b>\n'];

  lines.push(`Trades: ${stats.totalTrades} closed, ${stats.activeTrades} active`);
  lines.push(`Win rate: ${stats.winRate} (${stats.wins}W / ${stats.losses}L)`);
  lines.push(`Net P&L: ${stats.totalPnlPct >= 0 ? '+' : ''}${stats.totalPnlPct.toFixed(2)}%`);
  lines.push(`Avg win: +${stats.avgWinPct.toFixed(2)}% | Avg loss: ${stats.avgLossPct.toFixed(2)}%`);

  if (Object.keys(stats.byPair).length > 0) {
    lines.push('\n<b>By Pair:</b>');
    for (const [pair, data] of Object.entries(stats.byPair)) {
      const wr = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(0) : '0';
      lines.push(`  ${pair}: ${data.wins}W/${data.losses}L (${wr}%) — net ${data.totalPnlPct >= 0 ? '+' : ''}${data.totalPnlPct.toFixed(2)}%`);
    }
  }

  if (Object.keys(stats.byOrigin).length > 0) {
    lines.push('\n<b>By Origin:</b>');
    for (const [origin, data] of Object.entries(stats.byOrigin)) {
      lines.push(`  ${origin}: ${data.count} trade(s) — net ${data.pnlPct >= 0 ? '+' : ''}${data.pnlPct.toFixed(2)}%`);
    }
  }

  // Daily breakdown
  const days = Object.keys(dailyStats).sort().reverse().slice(0, 7);
  if (days.length > 0) {
    lines.push('\n<b>Daily:</b>');
    for (const day of days) {
      const d = dailyStats[day];
      lines.push(`  ${day}: ${d.wins}W/${d.losses}L — ${d.totalPnlPct >= 0 ? '+' : ''}${d.totalPnlPct.toFixed(2)}%`);
    }
  }

  lines.push(`\n${istTimestamp()} IST`);
  return lines.join('\n');
}

/**
 * Format daily P&L summary for Telegram (sent once per day).
 */
function formatDailySummary() {
  const stats = getTodayStats();
  const todayClosed = getTodayTrades();
  const session = getSessionStats();

  if (todayClosed.length === 0) {
    return `📊 <b>Daily Summary</b>\n\nNo trades closed today.\n\nSession total: ${session.totalTrades} trades, ${session.winRate} win rate, ${session.totalPnlPct >= 0 ? '+' : ''}${session.totalPnlPct.toFixed(2)}% net\n\n${istTimestamp()} IST`;
  }

  let lines = ['📊 <b>Daily P&L Summary</b>\n'];
  lines.push(`Trades today: ${todayClosed.length}`);
  lines.push(`Win rate: ${stats.wins + stats.losses > 0 ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0) : '0'}% (${stats.wins}W / ${stats.losses}L)`);
  lines.push(`Net P&L: ${stats.totalPnlPct >= 0 ? '+' : ''}${stats.totalPnlPct.toFixed(2)}%\n`);

  for (const t of todayClosed) {
    const emoji = t.pnlPct >= 0 ? '✅' : '❌';
    const durationMin = Math.round(t.durationMs / 60000);
    lines.push(`${emoji} ${t.pair} ${t.direction}: ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct?.toFixed(2)}% — ${t.exitReason} (${durationMin}min)`);
  }

  lines.push(`\nSession: ${session.totalTrades} trades, ${session.winRate} win rate, ${session.totalPnlPct >= 0 ? '+' : ''}${session.totalPnlPct.toFixed(2)}% net`);
  lines.push(`\n${istTimestamp()} IST`);
  return lines.join('\n');
}

// ── Whale Wallet Health ──────────────────────────────────────────────────
// Track when each whale wallet last had a position on any of our coins.
// If a wallet goes stale (no positions for 7+ days), alert.

const walletLastSeen = {};   // Key = wallet address, Value = { timestamp, coin, direction }
const WALLET_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Record that a whale wallet has a live position.
 * Called from signal-gate.js when whale positions are fetched.
 *
 * @param {string} address - Wallet address
 * @param {string} label - Human label
 * @param {string} coin - e.g. 'BTC'
 * @param {string} direction - 'LONG' or 'SHORT'
 */
function recordWhaleActivity(address, label, coin, direction) {
  walletLastSeen[address] = {
    timestamp: Date.now(),
    label,
    coin,
    direction,
  };
}

/**
 * Check if any tracked whale wallets have gone stale.
 * Returns array of stale wallet alerts.
 */
function checkWhaleWalletHealth() {
  const alerts = [];
  const now = Date.now();

  for (const [address, data] of Object.entries(walletLastSeen)) {
    const age = now - data.timestamp;
    if (age > WALLET_STALE_MS) {
      const daysSince = Math.round(age / (24 * 60 * 60 * 1000));
      alerts.push({
        address,
        label: data.label,
        lastCoin: data.coin,
        lastDirection: data.direction,
        daysSince,
        message: `${data.label} hasn't had a position on our coins in ${daysSince} days`,
      });
    }
  }

  return alerts;
}

/**
 * Get whale wallet health status for display.
 */
function getWhaleWalletStatus() {
  const entries = Object.entries(walletLastSeen);
  if (entries.length === 0) {
    return { tracked: 0, status: 'no data yet — wallets checked on next gate call' };
  }

  return entries.map(([address, data]) => {
    const ageMs = Date.now() - data.timestamp;
    const ageMin = Math.round(ageMs / 60000);
    const stale = ageMs > WALLET_STALE_MS;
    return {
      label: data.label,
      lastSeen: `${ageMin}min ago`,
      lastCoin: data.coin,
      lastDirection: data.direction,
      stale,
    };
  });
}

// ── Module Exports ───────────────────────────────────────────────────────

module.exports = {
  recordEntry,
  recordExit,
  getActiveTrades,
  getTodayTrades,
  getTodayStats,
  getSessionStats,
  getAllDailyStats,
  formatTradesSummary,
  formatJournalSummary,
  formatDailySummary,
  recordWhaleActivity,
  checkWhaleWalletHealth,
  getWhaleWalletStatus,
};
