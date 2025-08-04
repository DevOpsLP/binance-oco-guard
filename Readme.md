# Binance Futures OCO Guard

This is  a simple "file" that allows to run separately a websocket connection for a reliable "Order-Cancel-Order" functionality in Binance Futures USD-M

---

## 🚀 Features

- Listens to your Binance user stream in real-time
- Auto-cancels open orders when TP or SL fills
- Supports:
  - Full symbol-wide cancel
  - Per-side cancel (LONG / SHORT in Hedge Mode)
  - Per-clientId prefix cancel (for bracketed orders only)
- Auto reconnects if stream closes
- Keep-alive for listenKey
- Optional health check server

---

## 🧠 Requirements

- Node.js 18+ (for native `fetch`)
- Binance API key with USDT-M Futures permissions
- Futures account must be enabled

---

## 📦 Setup

#### 1. Clone the repository
#### 2. Create your .env file
##### ⚙️ .env example

```dotenv
# === REQUIRED ===
BINANCE_API_KEY=your_key_here
BINANCE_API_SECRET=your_secret_here

# === CANCEL MODE ===
# SYMBOL: Cancel all open orders on the same symbol
# SIDE: Cancel orders only on the same positionSide (LONG or SHORT)
# PREFIX: Cancel only orders that start with CLIENT_ID_PREFIX
CANCEL_MODE=SYMBOL

# === Used only if CANCEL_MODE=PREFIX ===
CLIENT_ID_PREFIX=brkt_

# === If you're using Hedge Mode Change to 1 instead of 0 (Binance Futures) ===
HEDGE_MODE=0

# === Optional Health Check Port ===
# Set to 0 to disable the health server
HEALTH_PORT=8080

# === Don't touch it unless you know what you are doing 📝 ===
BASE_URL=https://fapi.binance.com
FWS_BASE=wss://fstream.binance.com/ws
RECV_WINDOW=5000
KEEPALIVE_MINUTES=25
```
#### 3. Install dependencies and start as a service (running in the background)
```bash
# Install dependencies
npm install

# Install PM2 (service manager)
npm install pm2 -g

# Start the app using PM2
pm2 start app.js --name oco-guard

# Save the process list
pm2 save

# Set PM2 to auto-start on reboot
pm2 startup
```

##### ⚙️ PM2 Commands

```bash
# View logs
pm2 logs oco-guard

# Restart
pm2 restart oco-guard

# Stop
pm2 stop oco-guard

# Check status
pm2 status
```

