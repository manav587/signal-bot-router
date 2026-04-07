# Pine Script Setup — 1H EMA 9/21 Crossover (v3.7.0)

## What This Is

The relay has been upgraded from 4H to 1H signal timeframe. The 4H EMA 9/21 crossover was too slow — it lagged 8-16 hours behind actual turns and missed profitable moves entirely. The 1H timeframe catches turns in 2-4 hours instead.

The relay code is already updated (v3.7.0). This document covers the TradingView side: installing the new Pine Script indicator and creating alerts for all 4 pairs.

## CRITICAL RULES

1. **Create as a NEW indicator** — do NOT open Pine Editor and paste over whatever is currently loaded. Go to Pine Editor → click the dropdown arrow next to "Open" → select "New indicator script".
2. **Do NOT delete the old 4H alerts yet** — leave them until the new 1H alerts are confirmed firing correctly. Then delete the old ones.
3. **Every alert must use "Once Per Bar Close"** — this prevents repainting mid-candle.
4. **The chart timeframe must be set to 1H** before adding the indicator and creating alerts.

---

## Step 1: Add the Indicator to TradingView

1. Open TradingView chart for any of the 4 pairs (e.g., BTCUSDT.P on Binance Futures)
2. Set chart timeframe to **1H** (1 hour)
3. Open Pine Editor (tab at bottom of screen)
4. Click the dropdown arrow next to "Open" → select **"New indicator script"**
5. Select all existing code in the editor and delete it
6. Paste the following script:

```pine
//@version=5
indicator("Sentinel 1H EMA 9/21 Crossover v3.7.0", overlay=true)

ema9  = ta.ema(close, 9)
ema21 = ta.ema(close, 21)

plot(ema9,  "EMA 9",  color=color.new(color.blue, 0),  linewidth=2)
plot(ema21, "EMA 21", color=color.new(color.orange, 0), linewidth=2)

bullishCross = ta.crossover(ema9, ema21)
bearishCross = ta.crossunder(ema9, ema21)

plotshape(bullishCross, "Bull Cross", shape.triangleup,   location.belowbar, color.green, size=size.small)
plotshape(bearishCross, "Bear Cross", shape.triangledown, location.abovebar, color.red,   size=size.small)

alertcondition(bullishCross, title="LONG Signal",  message="EMA 9/21 bullish crossover on 1H")
alertcondition(bearishCross, title="SHORT Signal", message="EMA 9/21 bearish crossover on 1H")
```

7. Click **"Save"** (name it "Sentinel 1H EMA 9/21 Crossover v3.7.0")
8. Click **"Add to Chart"**
9. You should see blue (EMA9) and orange (EMA21) lines on the chart, with green/red triangles at crossover points

---

## Step 2: Create Alerts (8 total — 4 pairs × 2 directions)

For each alert below, follow this exact process:

1. Click the **alert bell icon** in TradingView toolbar, or press Alt+A
2. In the alert dialog:
   - **Condition**: Select "Sentinel 1H EMA 9/21 Crossover v3.7.0"
   - **Alert function**: Select the appropriate one (LONG Signal or SHORT Signal)
   - **Trigger**: Select **"Once Per Bar Close"**
   - **Expiration**: Set to "Open-ended" if available, or max duration
   - **Alert actions**: Check "Webhook URL"
   - **Webhook URL**: `https://signal-bot-router.onrender.com/webhook`
   - **Message**: Paste the EXACT JSON from the table below (replace default message entirely)
3. Click **"Create"**

**IMPORTANT**: You must switch the chart to each pair's symbol before creating its alerts. The indicator uses the chart's data, so BTCUSDT.P alerts must be created while viewing BTCUSDT.P, etc.

---

### Alert Messages (copy-paste exactly)

#### BTC LONG
Switch chart to: **BTCUSDT.P** (Binance Futures)
Condition: Sentinel 1H EMA 9/21 → **LONG Signal**
Message:
```
[{"action":"closeAllDeals","uuid":"21c9985a-db38-440d-9313-ac13825852be"},{"action":"stopBot","uuid":"21c9985a-db38-440d-9313-ac13825852be"},{"action":"startBot","uuid":"d0ea54dc-7218-4666-8c81-85bcd0271a3f"}]
```

#### BTC SHORT
Condition: Sentinel 1H EMA 9/21 → **SHORT Signal**
Message:
```
[{"action":"closeAllDeals","uuid":"d0ea54dc-7218-4666-8c81-85bcd0271a3f"},{"action":"stopBot","uuid":"d0ea54dc-7218-4666-8c81-85bcd0271a3f"},{"action":"startBot","uuid":"21c9985a-db38-440d-9313-ac13825852be"}]
```

#### ETH LONG
Switch chart to: **ETHUSDT.P** (Binance Futures)
Condition: Sentinel 1H EMA 9/21 → **LONG Signal**
Message:
```
[{"action":"closeAllDeals","uuid":"69c91263-68c9-4f88-a543-7c319b5fde8b"},{"action":"stopBot","uuid":"69c91263-68c9-4f88-a543-7c319b5fde8b"},{"action":"startBot","uuid":"4d6f6265-4c9a-42e7-bf85-8956a1c03f6c"}]
```

#### ETH SHORT
Condition: Sentinel 1H EMA 9/21 → **SHORT Signal**
Message:
```
[{"action":"closeAllDeals","uuid":"4d6f6265-4c9a-42e7-bf85-8956a1c03f6c"},{"action":"stopBot","uuid":"4d6f6265-4c9a-42e7-bf85-8956a1c03f6c"},{"action":"startBot","uuid":"69c91263-68c9-4f88-a543-7c319b5fde8b"}]
```

#### SOL LONG
Switch chart to: **SOLUSDT.P** (Binance Futures)
Condition: Sentinel 1H EMA 9/21 → **LONG Signal**
Message:
```
[{"action":"closeAllDeals","uuid":"3af77f4f-73a7-45c1-a0fd-b7c3ce9f16ee"},{"action":"stopBot","uuid":"3af77f4f-73a7-45c1-a0fd-b7c3ce9f16ee"},{"action":"startBot","uuid":"61a66c9f-7463-46db-a72f-2ef39565bc20"}]
```

#### SOL SHORT
Condition: Sentinel 1H EMA 9/21 → **SHORT Signal**
Message:
```
[{"action":"closeAllDeals","uuid":"61a66c9f-7463-46db-a72f-2ef39565bc20"},{"action":"stopBot","uuid":"61a66c9f-7463-46db-a72f-2ef39565bc20"},{"action":"startBot","uuid":"3af77f4f-73a7-45c1-a0fd-b7c3ce9f16ee"}]
```

#### XRP LONG
Switch chart to: **XRPUSDT.P** (Binance Futures)
Condition: Sentinel 1H EMA 9/21 → **LONG Signal**
Message:
```
[{"action":"closeAllDeals","uuid":"2751574b-cc46-4f62-bd01-cb404c21f8d7"},{"action":"stopBot","uuid":"2751574b-cc46-4f62-bd01-cb404c21f8d7"},{"action":"startBot","uuid":"eb74f76c-c6ec-48c2-a74d-d9fd27c2fab5"}]
```

#### XRP SHORT
Condition: Sentinel 1H EMA 9/21 → **SHORT Signal**
Message:
```
[{"action":"closeAllDeals","uuid":"eb74f76c-c6ec-48c2-a74d-d9fd27c2fab5"},{"action":"stopBot","uuid":"eb74f76c-c6ec-48c2-a74d-d9fd27c2fab5"},{"action":"startBot","uuid":"2751574b-cc46-4f62-bd01-cb404c21f8d7"}]
```

---

## Step 3: Verify

After creating all 8 alerts:

1. Check the TradingView Alert Manager — you should see 8 new alerts, all with webhook URLs
2. Wait for the next 1H candle close where an EMA crossover occurs on any pair
3. Check the relay health endpoint: `https://signal-bot-router.onrender.com/` — it should show version 3.7.0
4. Check Telegram — the relay will send a message when it receives the first signal

## Step 4: Clean Up (AFTER first successful signal)

Once you've confirmed the 1H alerts are firing and the relay is processing them correctly:

1. Delete the old 4H EMA crossover alerts (should be 8 alerts from the previous setup)
2. Optionally remove the old 4H indicator from the chart (but keeping it doesn't hurt)

---

## UUID Reference

| Pair | Direction | Bot Name | UUID |
|------|-----------|----------|------|
| BTC | LONG | BTC Long v2 | d0ea54dc-7218-4666-8c81-85bcd0271a3f |
| BTC | SHORT | BTC Short v2 | 21c9985a-db38-440d-9313-ac13825852be |
| ETH | LONG | ETH Long v2 | 4d6f6265-4c9a-42e7-bf85-8956a1c03f6c |
| ETH | SHORT | ETH Short v2 | 69c91263-68c9-4f88-a543-7c319b5fde8b |
| SOL | LONG | SOL Long v2 | 61a66c9f-7463-46db-a72f-2ef39565bc20 |
| SOL | SHORT | SOL Short v2 | 3af77f4f-73a7-45c1-a0fd-b7c3ce9f16ee |
| XRP | LONG | XRP Long v2 | eb74f76c-c6ec-48c2-a74d-d9fd27c2fab5 |
| XRP | SHORT | XRP Short v2 | 2751574b-cc46-4f62-bd01-cb404c21f8d7 |

## What Changed in v3.7.0 (Relay Side)

- Signal timeframe: 4H → 1H (catches moves in 2-4 hours instead of 8-16)
- RSI thresholds tightened: 30/70 → 35/65 (filters more noise on faster timeframe)
- Circuit breaker: 3 flips → 2 flips in 15 min triggers 30-min park
- Reval grace period: 5 min → 20 min (gives 1H entries time to develop)
- ATR threshold: 1.0% → 0.5% (1H naturally has lower volatility per candle)
- All Telegram alerts now show "Signal: 1H EMA 9/21" label
