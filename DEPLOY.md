# Signal Bot Router — Deployment Guide

## What This Does
Sits between TradingView and Gainium. Receives your webhook alerts and forwards each action ONE AT A TIME with delays, so Binance has time to clear positions before the next bot starts.

**Without relay:** closeAllDeals + stopBot + startBot fire simultaneously → position conflict → silent failure
**With relay:** closeAllDeals → 5s wait → stopBot → 2s wait → startBot → clean flip ✅

---

## Step 1: Push to GitHub

1. Create a new repository on GitHub: `signal-bot-router`
2. Push this folder:

```bash
cd signal-bot-router
git init
git add package.json src/server.js render.yaml
git commit -m "Signal Bot Router v1.0.0"
git remote add origin https://github.com/YOUR_USERNAME/signal-bot-router.git
git push -u origin main
```

---

## Step 2: Deploy on Render.com (Free)

1. Go to https://render.com and sign up (free) with your GitHub account
2. Click **"New" → "Web Service"**
3. Connect your `signal-bot-router` GitHub repo
4. Render auto-detects settings from `render.yaml`:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Click **"Deploy Web Service"**
6. Wait ~2 minutes for deploy to complete
7. Your URL will be: `https://signal-bot-router.onrender.com`

Test it: visit `https://signal-bot-router.onrender.com/` in your browser — you should see:
```json
{"service":"Signal Bot Router","status":"running","uptime":"...","version":"1.0.0"}
```

---

## Step 3: Update TradingView Alerts

Change the **Webhook URL** on ALL 9 alerts from:
```
https://api.gainium.io/trade_signal
```
to:
```
https://signal-bot-router.onrender.com/webhook
```

**Alert messages stay exactly the same.** The emoji text prefix is fine — the relay extracts the JSON automatically.

### Alerts to Update:
1. SOL Bullish Crossover
2. SOL Bearish Crossover
3. SOL Kill Switch
4. ETH Bullish Crossover
5. ETH Bearish Crossover
6. ETH Kill Switch
7. XRP Bullish Crossover
8. XRP Bearish Crossover
9. XRP Kill Switch

---

## Step 4: Test

After updating one alert (e.g., SOL Bullish), wait for the next crossover signal or manually trigger an alert in TradingView. Check:
- Render.com dashboard → "Logs" tab shows the sequential processing
- Gainium should execute the flip cleanly

---

## Notes

- **Free tier on Render spins down after 15 minutes of inactivity.** First request after spin-down takes ~30 seconds to cold-start. TradingView retries failed webhooks, so this is usually fine. If you want zero cold starts, upgrade to Render's $7/month Starter plan.
- **Logs** are visible in the Render dashboard under your service → "Logs"
- **No API keys needed.** The relay uses the same Gainium trade_signal endpoint with UUIDs as auth.
