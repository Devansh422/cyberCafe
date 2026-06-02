'use strict';
// Ratan WhatsApp sidecar.
//
// A standalone Node process that owns the whatsapp-web.js client (which drives a
// headless Chromium via puppeteer) and talks to the Rust core over localhost:
//   • pushes status/QR  → POST {CORE_URL}/api/system/whatsapp/state
//   • posts imported media → POST {CORE_URL}/api/system/whatsapp/import (multipart)
//   • accepts            → POST /start    (begin/refresh the client)
//                          POST /logout   (unlink current number, show a new QR)
//                          POST /shutdown (close the browser cleanly and exit)
//
// whatsapp-web.js and qrcode are required lazily inside startClient() so this
// process boots (and serves /health + pushes an initial state) even before its
// heavy dependencies are installed — the Rust core spawns it unconditionally.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');

const WA_PORT = parseInt(process.env.WA_PORT || '5099', 10);
const CORE_URL = (process.env.CORE_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');
const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '.wwebjs_auth');
const READY_TIMEOUT_MS = parseInt(process.env.WA_READY_TIMEOUT_MS || '75000', 10);
const SESSION_RESET_AFTER = 3;
const MAX_IMPORT_ATTEMPTS = 3;

// LocalAuth stores the Chromium user-data-dir at <dataPath>/session-<clientId>.
// This is the directory puppeteer locks (and the one we must reap on recovery).
const PROFILE_DIR = path.join(SESSION_DIR, 'session-ratan');

const state = { status: 'idle', qr: null, qrGeneratedAt: null, lastError: null };
let client = null;
let reconnecting = false;
let reconnectCount = 0;
let consecutiveFailures = 0;
let readyWatchdog = null;
// PID of the Chromium puppeteer launched, so we can kill its whole tree on
// shutdown/recovery even if a clean close fails.
let browserPid = null;
let shuttingDown = false;

function log(...a) { console.log('[wa-sidecar]', ...a); }

// Reject a promise if it doesn't settle within `ms`. Used to bound WhatsApp
// network calls (logout/destroy) so an offline revoke can't hang forever.
function withTimeout(promise, ms, label = 'op') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

// ---- browser lifecycle / crash recovery ------------------------------------

// Files Chrome leaves in the profile dir when it dies uncleanly. While present,
// puppeteer reports "The browser is already running … Use a different
// userDataDir or stop the running browser first." on the next launch (it checks
// for `lockfile` specifically on Windows). Removing them is safe once no browser
// is actually using the profile.
const LOCK_FILES = ['lockfile', 'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'];

function clearBrowserLocks() {
  for (const name of LOCK_FILES) {
    try { fs.rmSync(path.join(PROFILE_DIR, name), { force: true }); } catch { /* ignore */ }
  }
}

function lockfilePresent() {
  try { return fs.existsSync(path.join(PROFILE_DIR, 'lockfile')); } catch { return false; }
}

// Kill a process and its child renderers. Windows-only tree kill; best-effort.
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

// Find and kill any leftover Chromium still bound to OUR profile dir — the
// orphan from a previous run that was force-killed (e.g. the app was closed
// while offline). We match strictly on our own session profile path, so the
// user's normal Chrome/Edge is never touched. Windows-only; resolves quietly.
function reapOrphanBrowsers() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    const needle = PROFILE_DIR.replace(/'/g, "''");
    const ps =
      `Get-CimInstance Win32_Process | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ` +
      `ForEach-Object { $_.ProcessId }`;
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 8000, windowsHide: true },
      (_err, stdout) => {
        const pids = String(stdout || '')
          .split(/\r?\n/)
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n !== process.pid);
        for (const pid of pids) { log('reaping orphaned browser pid', pid); killTree(pid); }
        resolve();
      },
    );
  });
}

// Kill whatever browser this sidecar owns and scrub the lock files. Called on
// recovery and shutdown so we never hand the next launch a wedged profile.
async function teardownBrowser(destroy) {
  if (destroy) { try { await destroy.destroy(); } catch (e) { log('browser destroy failed:', e.message); } }
  killTree(browserPid);
  browserPid = null;
  clearBrowserLocks();
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
    return true;
  } catch (e) {
    log('import POST failed:', e.message);
    return false;
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
  await teardownBrowser(dead);
  scheduleReconnect(4000);
}

function clearSession() {
  killTree(browserPid);
  browserPid = null;
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); consecutiveFailures = 0; log('cleared session'); }
  catch (e) { log('could not clear session:', e.message); }
}

function scheduleReconnect(delay = 10000) {
  if (shuttingDown || reconnecting) return;
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

// ---- media import: serialized + retried ------------------------------------
//
// WhatsApp delivers an album of photos as several rapid `message` events. Each
// downloadMedia() runs decryption inside the single shared puppeteer page, and
// firing them concurrently is exactly what produces the intermittent "multiple
// photos" failures and dropped images. We therefore funnel every download
// through one queue (one at a time) and retry transient failures. The Rust core
// dedups by SHA-256, so a retry that re-sends bytes can never double-import.

let mediaChain = Promise.resolve();
function runQueued(task) {
  // Chain regardless of the previous task's outcome so one failure can't stall
  // the queue. Each task is responsible for its own error handling.
  mediaChain = mediaChain.then(task, task);
  return mediaChain;
}

const seen = new Set();
const SEEN_MAX = 1000;
function markSeen(id) {
  seen.add(id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
}
function msgId(msg) {
  return msg.id?._serialized || `${msg.from}:${msg.t || Date.now()}`;
}

function scheduleImport(msg, attempt = 1) {
  runQueued(() => importOnce(msg, attempt));
}

async function importOnce(msg, attempt) {
  const id = msgId(msg);
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) throw new Error('empty media payload');
    const buffer = Buffer.from(media.data, 'base64');
    const contact = await msg.getContact().catch(() => null);
    const customerName = (contact && (contact.pushname || contact.name)) || null;
    const customerPhone = (msg.from || '').split('@')[0].split(':')[0];
    const originalName = media.filename || guessName(media.mimetype);
    const ok = await importMedia(buffer, { originalName, mimeType: media.mimetype, customerName, customerPhone });
    if (!ok) throw new Error('core rejected import');
    log(`imported ${originalName} from ${customerName || customerPhone} (attempt ${attempt})`);
  } catch (e) {
    if (attempt < MAX_IMPORT_ATTEMPTS) {
      const backoff = 1200 * attempt;
      log(`import attempt ${attempt}/${MAX_IMPORT_ATTEMPTS} failed: ${e.message} — retry in ${backoff}ms`);
      // Re-enqueue at the tail after a backoff so other queued photos aren't
      // blocked while this one waits.
      setTimeout(() => scheduleImport(msg, attempt + 1), backoff);
    } else {
      seen.delete(id); // allow a future manual resend to be retried fresh
      log(`import gave up after ${MAX_IMPORT_ATTEMPTS} attempts: ${e.message}`);
    }
  }
}

// Incoming media from a customer.
function onIncoming(msg) {
  if (!msg.hasMedia || !mimeToExt(msg.type)) return;
  const id = msgId(msg);
  if (seen.has(id)) return;
  markSeen(id);
  scheduleImport(msg, 1);
}

// Media the operator drops into their own "Message yourself" chat. The cheap
// metadata lookups run outside the media queue; only the heavy download is
// serialized via scheduleImport.
async function onSelf(msg) {
  if (!msg.fromMe || !msg.hasMedia || !mimeToExt(msg.type)) return;
  let isSelf = false;
  try {
    const chat = await msg.getChat();
    if (chat && !chat.isGroup) {
      const contact = await chat.getContact();
      isSelf = !!(contact && contact.isMe);
    }
  } catch (e) {
    log('self-chat detect failed:', e.message);
    return;
  }
  if (!isSelf) return;
  const id = msgId(msg);
  if (seen.has(id)) return;
  markSeen(id);
  scheduleImport(msg, 1);
}

async function startClient() {
  if (shuttingDown || client) return;
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

  // Recover from an unclean previous exit: if a stale lockfile is present, kill
  // any orphaned browser still holding our profile before we try to launch.
  if (lockfilePresent()) {
    log('stale lockfile detected — reaping orphaned browser before launch');
    await reapOrphanBrowsers();
  }
  clearBrowserLocks();

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
    consecutiveFailures += 1; clearWatchdog();
    const dead = client; client = null;
    teardownBrowser(dead).catch(() => {});
    setStatus('auth_failed', { lastError: String(m) });
    scheduleReconnect(20000);
  });
  client.on('ready', () => {
    state.qr = null; state.lastError = null; clearWatchdog();
    reconnectCount = 0; consecutiveFailures = 0;
    try { browserPid = client?.pupBrowser?.process?.()?.pid || browserPid; } catch { /* ignore */ }
    setStatus('ready');
    log('client ready');
  });
  client.on('disconnected', (r) => {
    clearWatchdog();
    const dead = client; client = null;
    teardownBrowser(dead).catch(() => {});
    setStatus('disconnected', { lastError: String(r) });
    scheduleReconnect(15000);
  });
  client.on('message', (msg) => { try { onIncoming(msg); } catch (e) { log('msg err', e.message); } });
  client.on('message_create', (msg) => { onSelf(msg).catch((e) => log('self err', e.message)); });

  armWatchdog();
  try {
    await client.initialize();
    try { browserPid = client?.pupBrowser?.process?.()?.pid || null; } catch { browserPid = null; }
  } catch (e) {
    const msg = e.message || String(e);
    consecutiveFailures += 1; clearWatchdog();
    const dead = client; client = null;
    await teardownBrowser(dead);
    // The classic "browser already running" / launch failure: an orphan still
    // holds the profile. Reap it so the scheduled retry can succeed.
    if (/already running|Failed to launch|ProcessSingleton/i.test(msg)) {
      log('launch blocked by a stale browser — reaping and retrying');
      await reapOrphanBrowsers();
      clearBrowserLocks();
    }
    setStatus('error', { lastError: msg });
    scheduleReconnect(8000);
  }
}

// Unlink the current number and present a fresh QR for a different one. logout()
// tells WhatsApp to drop the linked device AND removes the LocalAuth session;
// if the client isn't connected we fall back to destroying + wiping the profile.
async function revokeSession() {
  log('revoking WhatsApp session');
  clearWatchdog();
  reconnecting = false; reconnectCount = 0; consecutiveFailures = 0;
  setStatus('logging_out', { qr: null, qrGeneratedAt: null, lastError: null });

  const c = client; client = null;
  if (c) {
    try {
      // logout() talks to the WA servers, which can hang if we're offline —
      // bound it so a revoke while disconnected still completes (we fall back to
      // a local wipe below). unlink device on the phone + remove session.
      await withTimeout(c.logout(), 12000, 'logout');
      log('logged out — device unlinked');
    } catch (e) {
      log('logout failed/timed out, falling back to destroy:', e.message);
      try { await withTimeout(c.destroy(), 8000, 'destroy'); } catch { /* ignore */ }
    }
  }
  killTree(browserPid);
  browserPid = null;
  await reapOrphanBrowsers();
  // Make sure the profile is gone so the next start shows a brand-new QR.
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (e) { log('profile wipe failed:', e.message); }
  clearBrowserLocks();

  setStatus('idle', { qr: null, qrGeneratedAt: null, lastError: null });
  // Auto-start so a QR appears immediately, ready to link a new number.
  startClient().catch((e) => log('post-logout start failed:', e.message));
}

// Close the browser cleanly and exit. Used on SIGINT/SIGTERM and POST /shutdown
// so a normal app close doesn't leave an orphaned Chromium holding the profile.
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down — closing browser');
  clearWatchdog();
  const dead = client; client = null;
  await teardownBrowser(dead);
  try { server.close(); } catch { /* ignore */ }
  process.exit(code);
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
  if (req.method === 'POST' && req.url === '/logout') {
    revokeSession().catch((e) => log('logout error:', e.message));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'POST' && req.url === '/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    shutdown(0);
    return;
  }
  res.writeHead(404);
  res.end();
});

process.on('SIGINT', () => { shutdown(0); });
process.on('SIGTERM', () => { shutdown(0); });
// Last-ditch synchronous cleanup if the process is exiting for any other reason.
process.on('exit', () => { killTree(browserPid); });

server.listen(WA_PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${WA_PORT}  (core=${CORE_URL}, session=${SESSION_DIR})`);
  pushState(); // announce initial 'idle' to the core
});
