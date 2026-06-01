'use strict';
// Ratan WhatsApp sidecar.
//
// A standalone Node process that owns the whatsapp-web.js client (which drives a
// headless Chromium via puppeteer) and talks to the Rust core over localhost:
//   • pushes status/QR  → POST {CORE_URL}/api/system/whatsapp/state
//   • posts imported media → POST {CORE_URL}/api/system/whatsapp/import (multipart)
//   • accepts            → POST /start  (begin/refresh the client)
//
// whatsapp-web.js and qrcode are required lazily inside startClient() so this
// process boots (and serves /health + pushes an initial state) even before its
// heavy dependencies are installed — the Rust core spawns it unconditionally.

const http = require('http');
const path = require('path');
const fs = require('fs');

const WA_PORT = parseInt(process.env.WA_PORT || '5099', 10);
const CORE_URL = (process.env.CORE_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');
const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '.wwebjs_auth');
const READY_TIMEOUT_MS = parseInt(process.env.WA_READY_TIMEOUT_MS || '75000', 10);
const SESSION_RESET_AFTER = 3;

const state = { status: 'idle', qr: null, qrGeneratedAt: null, lastError: null };
let client = null;
let reconnecting = false;
let reconnectCount = 0;
let consecutiveFailures = 0;
let readyWatchdog = null;

function log(...a) { console.log('[wa-sidecar]', ...a); }

async function pushState() {
  const qrAge = state.qrGeneratedAt ? Math.floor((Date.now() - state.qrGeneratedAt) / 1000) : null;
  const body = JSON.stringify({ status: state.status, qr: state.qr, qrAge, lastError: state.lastError });
  try {
    await fetch(`${CORE_URL}/api/system/whatsapp/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (e) {
    // Core may not be up yet — non-fatal.
  }
}

function setStatus(status, extra = {}) {
  state.status = status;
  Object.assign(state, extra);
  pushState();
}

async function importMedia(buffer, meta) {
  try {
    const fd = new FormData();
    fd.append('file', new Blob([buffer]), meta.originalName || 'file.bin');
    if (meta.mimeType) fd.append('mimeType', meta.mimeType);
    if (meta.customerName) fd.append('customerName', meta.customerName);
    if (meta.customerPhone) fd.append('customerPhone', meta.customerPhone);
    const res = await fetch(`${CORE_URL}/api/system/whatsapp/import`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`core import ${res.status}`);
    log('imported', meta.originalName, 'from', meta.customerName || meta.customerPhone);
  } catch (e) {
    log('import failed:', e.message);
  }
}

function findChromiumPath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) {
    if (c.endsWith('.exe') && fs.existsSync(c)) return c;
  }
  return null;
}

function clearWatchdog() {
  if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
}
function armWatchdog(ms = READY_TIMEOUT_MS) {
  clearWatchdog();
  readyWatchdog = setTimeout(() => {
    readyWatchdog = null;
    if (state.status === 'ready' || state.status === 'awaiting_qr') return;
    consecutiveFailures += 1;
    forceReconnect(`stuck at "${state.status}" for ${Math.round(ms / 1000)}s`);
  }, ms);
  if (readyWatchdog.unref) readyWatchdog.unref();
}

async function forceReconnect(reason) {
  log('watchdog:', reason, '— restarting');
  clearWatchdog();
  const dead = client; client = null;
  setStatus('reconnecting');
  if (dead) { try { await dead.destroy(); } catch {} }
  scheduleReconnect(4000);
}

function clearSession() {
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); consecutiveFailures = 0; log('cleared session'); }
  catch (e) { log('could not clear session:', e.message); }
}

function scheduleReconnect(delay = 10000) {
  if (reconnecting) return;
  if (consecutiveFailures >= SESSION_RESET_AFTER) { clearSession(); reconnectCount = 0; }
  if (reconnectCount >= 5) { setStatus('failed'); log('giving up after max reconnects'); return; }
  reconnecting = true; reconnectCount += 1;
  setTimeout(() => { reconnecting = false; startClient().catch((e) => log('reconnect failed:', e.message)); }, delay);
}

function mimeToExt(type) {
  const map = { image: '.jpg', document: '.pdf', video: null, audio: null, sticker: null };
  return map[type] !== undefined ? map[type] : '.bin';
}
function guessName(mime) {
  if (!mime) return 'file.bin';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'photo.jpg';
  if (mime.includes('png')) return 'image.png';
  if (mime.includes('pdf')) return 'document.pdf';
  if (mime.includes('word') || mime.includes('docx')) return 'document.docx';
  return 'file.bin';
}

async function handleMessage(msg) {
  if (!msg.hasMedia) return;
  const ext = mimeToExt(msg.type);
  if (!ext) return;
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return;
    const buffer = Buffer.from(media.data, 'base64');
    const contact = await msg.getContact().catch(() => null);
    const customerName = (contact && (contact.pushname || contact.name)) || null;
    const customerPhone = (msg.from || '').split('@')[0].split(':')[0];
    await importMedia(buffer, { originalName: media.filename || guessName(media.mimetype), mimeType: media.mimetype, customerName, customerPhone });
  } catch (e) {
    log('message handler error:', e.message);
  }
}

async function handleSelfMessage(msg) {
  if (!msg.fromMe || !msg.hasMedia) return;
  try {
    const chat = await msg.getChat();
    if (!chat || chat.isGroup) return;
    const contact = await chat.getContact();
    if (!(contact && contact.isMe)) return; // only the "Message yourself" chat
    return handleMessage(msg);
  } catch (e) {
    log('self-message detect failed:', e.message);
  }
}

async function startClient() {
  if (client) return;
  if (state.status === 'failed') { reconnectCount = 0; consecutiveFailures = 0; }

  let Client, LocalAuth, QRCode;
  try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
    QRCode = require('qrcode');
  } catch (e) {
    setStatus('unavailable', { lastError: 'whatsapp-web.js not installed in sidecar' });
    log('module not loaded:', e.message);
    return;
  }

  setStatus('starting');
  const puppeteer = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--disable-extensions'],
  };
  const chrome = findChromiumPath();
  if (chrome) puppeteer.executablePath = chrome;

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'ratan', dataPath: SESSION_DIR }),
    puppeteer,
  });

  client.on('qr', async (qr) => {
    try {
      state.qr = await QRCode.toDataURL(qr, { margin: 2, width: 360, errorCorrectionLevel: 'H' });
      state.qrGeneratedAt = Date.now();
    } catch (e) { log('qr encode failed:', e.message); }
    clearWatchdog();
    setStatus('awaiting_qr');
    log('QR ready — scan within 60s');
  });
  client.on('loading_screen', () => { setStatus('loading'); armWatchdog(); });
  client.on('authenticated', () => { state.qr = null; armWatchdog(); setStatus('authenticated'); });
  client.on('auth_failure', (m) => {
    consecutiveFailures += 1; clearWatchdog(); client = null;
    setStatus('auth_failed', { lastError: String(m) });
    scheduleReconnect(20000);
  });
  client.on('ready', () => {
    state.qr = null; state.lastError = null; clearWatchdog();
    reconnectCount = 0; consecutiveFailures = 0;
    setStatus('ready');
    log('client ready');
  });
  client.on('disconnected', (r) => {
    clearWatchdog(); client = null;
    setStatus('disconnected', { lastError: String(r) });
    scheduleReconnect(15000);
  });
  client.on('message', (msg) => { handleMessage(msg).catch((e) => log('msg err', e.message)); });
  client.on('message_create', (msg) => { handleSelfMessage(msg).catch((e) => log('self err', e.message)); });

  armWatchdog();
  try {
    await client.initialize();
  } catch (e) {
    consecutiveFailures += 1; clearWatchdog(); client = null;
    setStatus('error', { lastError: e.message });
    scheduleReconnect(20000);
  }
}

// ---- tiny HTTP control server ----------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'GET' && req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state));
  }
  if (req.method === 'POST' && req.url === '/start') {
    startClient().catch((e) => log('start error:', e.message));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(404);
  res.end();
});

server.listen(WA_PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${WA_PORT}  (core=${CORE_URL}, session=${SESSION_DIR})`);
  pushState(); // announce initial 'idle' to the core
});
