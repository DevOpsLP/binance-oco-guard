// Binance USDT-M OCO Guard (standalone, Node.js 18+)
// Cancels remaining orders when a close-position TP/SL fills.
// Requires: Node 18+ (global fetch), dependency: "ws"
require("dotenv").config(); 
const { createHmac } = require("node:crypto");
const http = require("node:http");
const { WebSocket } = require("ws");

// ---- ENV ----
const env = (k, d = "") => (process.env[k] ?? d);
const API_KEY = env("BINANCE_API_KEY");
const API_SECRET = env("BINANCE_API_SECRET");
if (!API_KEY || !API_SECRET) throw new Error("Set BINANCE_API_KEY and BINANCE_API_SECRET");

if (typeof fetch !== "function") {
  throw new Error("This app needs Node.js 18+ (global fetch).");
}

const BASE_URL = env("BASE_URL", "https://fapi.binance.com");
const FWS_BASE = env("FWS_BASE", "wss://fstream.binance.com/ws");
const RECV_WINDOW = Number(env("RECV_WINDOW", "5000"));
const KEEPALIVE_MINUTES = Number(env("KEEPALIVE_MINUTES", "25"));

// Cancel policy when one leg (TP/SL closePosition) fills:
//   SYMBOL  = cancel ALL open orders on that symbol (simple, blunt)
//   SIDE    = cancel only orders with same positionSide (LONG/SHORT) — for Hedge Mode
//   PREFIX  = cancel only orders whose clientOrderId starts with CLIENT_ID_PREFIX
const CANCEL_MODE = env("CANCEL_MODE", "SYMBOL"); // SYMBOL | SIDE | PREFIX
const CLIENT_ID_PREFIX = env("CLIENT_ID_PREFIX", "brkt_");
const HEDGE_MODE = env("HEDGE_MODE", "0") === "1";

// Optional lightweight health server (set HEALTH_PORT=0 to disable)
const HEALTH_PORT = Number(env("HEALTH_PORT", "8080"));

// ---- utils ----
const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), ...a);

const toQuery = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) sp.append(k, String(v));
  return sp.toString();
};
const sig = (q) => createHmac("sha256", API_SECRET).update(q).digest("hex");

async function signed(method, path, params = {}) {
  const q = toQuery({ ...params, timestamp: Date.now(), recvWindow: RECV_WINDOW });
  const url = `${BASE_URL}${path}?${q}&signature=${sig(q)}`;
  const res = await fetch(url, { method, headers: { "X-MBX-APIKEY": API_KEY } });
  const text = await res.text();
  if (!res.ok) throw new Error(`BINANCE ${method} ${path} ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function getListenKey() {
  const res = await fetch(`${BASE_URL}/fapi/v1/listenKey`, { method: "POST", headers: { "X-MBX-APIKEY": API_KEY } });
  if (!res.ok) throw new Error(`listenKey POST ${res.status}: ${await res.text()}`);
  return (await res.json()).listenKey;
}
async function keepAliveListenKey(listenKey) {
  const res = await fetch(`${BASE_URL}/fapi/v1/listenKey?${toQuery({ listenKey })}`, { method: "PUT", headers: { "X-MBX-APIKEY": API_KEY } });
  if (!res.ok) warn("[OCO] keepalive:", await res.text());
}
async function deleteListenKey(listenKey) {
  try { await fetch(`${BASE_URL}/fapi/v1/listenKey?${toQuery({ listenKey })}`, { method: "DELETE", headers: { "X-MBX-APIKEY": API_KEY } }); }
  catch { /* ignore */ }
}

// ---- cancel helpers ----
async function cancelAllOpenOrders(symbol) {
  await signed("DELETE", "/fapi/v1/allOpenOrders", { symbol });
}
async function cancelBySide(symbol, positionSide) {
  const open = await signed("GET", "/fapi/v1/openOrders", { symbol });
  const targets = open.filter(o => (o.positionSide || "") === positionSide);
  await Promise.allSettled(targets.map(o => signed("DELETE", "/fapi/v1/order", { symbol, orderId: o.orderId })));
  return targets.length;
}
async function cancelByPrefix(symbol, prefix) {
  const open = await signed("GET", "/fapi/v1/openOrders", { symbol });
  const targets = open.filter(o => (o.clientOrderId || "").startsWith(prefix));
  await Promise.allSettled(targets.map(o => signed("DELETE", "/fapi/v1/order", { symbol, orderId: o.orderId })));
  return targets.length;
}

// ---- WS logic ----
const state = {
  connected: false,
  listenKey: null,
  reconnects: 0,
  lastEventAt: 0,
  lastOrderUpdateAt: 0,
  lastError: null
};

let ws = null;
let kaTimer = null;
let backoffMs = 1000;

function isCloseFilled(o) {
  const type = o?.ot;   // order type (e.g. STOP_MARKET), Don't use o.o because it can be "LIMIT" or "MARKET" for TP/SL
  const status = o?.X; // FILLED, NEW, etc.
  const closePos = o?.cp === true || o?.cp === "true";
  const closeType = type === "STOP_MARKET" || type === "TAKE_PROFIT_MARKET" || type === "STOP" || type === "TAKE_PROFIT";
  return closePos && closeType && status === "FILLED";
}

async function handleOcoCancel(symbol, positionSide) {
  try {
    if (CANCEL_MODE === "PREFIX" && CLIENT_ID_PREFIX) {
      const n = await cancelByPrefix(symbol, CLIENT_ID_PREFIX);
      log(`[OCO] canceled ${n} prefix("${CLIENT_ID_PREFIX}") orders on ${symbol}`);
    } else if (CANCEL_MODE === "SIDE" || (HEDGE_MODE && positionSide)) {
      const n = await cancelBySide(symbol, positionSide || "BOTH?");
      log(`[OCO] canceled ${n} orders on ${symbol} side=${positionSide}`);
    } else {
      let cancelled = await cancelAllOpenOrders(symbol);
      log(`[OCO] canceled ALL open orders on ${cancelled} orders on ${symbol}`);
    }
  } catch (e) {
    warn("[OCO] cancel error:", e?.message || e);
  }
}

function onMessage(data) {
  let raw;
  try { raw = JSON.parse(data); } catch { return; }
  const m = raw.data || raw;
  if (m.e !== "ORDER_TRADE_UPDATE") return;
  state.lastEventAt = Date.now();
  const o = m.o;
  if (isCloseFilled(o)) {
    state.lastOrderUpdateAt = Date.now();
    const symbol = o.s;
    const ps = o.ps; // LONG/SHORT in Hedge Mode
    handleOcoCancel(symbol, ps);
  }
}

function onError(err) {
  state.lastError = String(err?.message || err);
  warn("[OCO] ws error:", state.lastError);
}

async function onClose() {
  state.connected = false;
  if (kaTimer) clearInterval(kaTimer);
  kaTimer = null;
  await deleteListenKey(state.listenKey);
  scheduleReconnect();
}

function scheduleReconnect() {
  state.reconnects++;
  const delay = Math.min(backoffMs * (1 + Math.random()), 60_000);
  log(`[OCO] reconnecting in ${Math.round(delay)}ms… (attempt ${state.reconnects})`);
  setTimeout(connect, delay);
  backoffMs = Math.min(backoffMs * 2, 60_000);
}

async function connect() {
  try {
    state.listenKey = await getListenKey();
    ws = new WebSocket(`${FWS_BASE}/${state.listenKey}`);

    ws.on("open", () => {
      state.connected = true;
      backoffMs = 1000;
      log("[OCO] user stream connected");
      kaTimer = setInterval(() => keepAliveListenKey(state.listenKey).catch(() => {}), KEEPALIVE_MINUTES * 60_000);
    });
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  } catch (e) {
    onError(e);
    scheduleReconnect();
  }
}

// ---- health server (optional) ----
if (HEALTH_PORT > 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${HEALTH_PORT}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && url.pathname === "/health") {
      res.end(JSON.stringify({ ok: true, now: Date.now(), ...state }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  server.listen(HEALTH_PORT, () => log(`[OCO] health server on :${HEALTH_PORT}`));
}

// ---- boot & shutdown ----
log("[OCO] starting…");
connect();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
async function shutdown() {
  log("[OCO] shutting down…");
  if (kaTimer) clearInterval(kaTimer);
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
  try { if (state.listenKey) await deleteListenKey(state.listenKey); } catch {}
  process.exit(0);
}
