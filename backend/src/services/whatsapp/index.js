const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const config = require('../../lib/config');
const media = require('../media');
const activity = require('../../db/activity');

function findChromiumPath() {
  // Real browser executables only — a directory like the old `.local-chromium`
  // entry is useless to Puppeteer. Try Chrome, then Edge, then whatever
  // Puppeteer bundled. Returns null to let Puppeteer auto-detect as a last resort.
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
  try {
    const puppeteer = require('puppeteer');
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch { /* puppeteer not resolvable */ }
  return null;
}

// If the client connects but never reaches `ready` within this window, the
// session is wedged (the classic "stuck at loading" after a reboot). The
// watchdog tears the client down and reconnects rather than hanging forever.
const READY_TIMEOUT_MS = parseInt(process.env.WA_READY_TIMEOUT_MS || '75000', 10);
// After this many consecutive failed recovery attempts we assume the saved
// session is corrupt and wipe it so the next start shows a fresh QR.
const SESSION_RESET_AFTER = 3;
const SESSION_DIR = path.join(__dirname, '..', '..', '..', '.wwebjs_auth');

class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.qrDataUrl = null;
    this.qrRaw = null;
    this.qrGeneratedAt = null;
    this.status = 'idle';
    this.lastError = null;
    this.attempts = new Map();
    this._reconnecting = false;
    this._reconnectCount = 0;
    this._readyWatchdog = null;
    this._consecutiveFailures = 0;
  }

  getState() {
    return {
      enabled: config.whatsappEnabled,
      status: this.status,
      qr: this.qrDataUrl,
      qrAge: this.qrGeneratedAt ? Math.floor((Date.now() - this.qrGeneratedAt) / 1000) : null,
      lastError: this.lastError,
    };
  }

  async start() {
    if (!config.whatsappEnabled) {
      this.status = 'disabled';
      return;
    }
    if (this.client) return;
    // A manual start after we'd given up ('failed') is an explicit retry —
    // clear the counters so the operator gets a full fresh set of attempts.
    if (this.status === 'failed') {
      this._reconnectCount = 0;
      this._consecutiveFailures = 0;
    }

    let Client, LocalAuth;
    try {
      ({ Client, LocalAuth } = require('whatsapp-web.js'));
    } catch (err) {
      this.status = 'unavailable';
      this.lastError = 'whatsapp-web.js not installed — run npm install in /backend';
      console.warn('[whatsapp] module not loaded:', err.message);
      return;
    }

    this.status = 'starting';
    console.log('[whatsapp] starting client…');

    const puppeteerOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
      ],
    };

    const chromePath = findChromiumPath();
    if (chromePath && chromePath.endsWith('.exe') && fs.existsSync(chromePath)) {
      puppeteerOpts.executablePath = chromePath;
      console.log('[whatsapp] using Chrome at', chromePath);
    }

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'ratan',
        dataPath: path.join(__dirname, '..', '..', '..', '.wwebjs_auth'),
      }),
      puppeteer: puppeteerOpts,
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023723176-alpha.html',
      },
    });

    this.client.on('qr', async (qr) => {
      this.qrRaw = qr;
      this.qrGeneratedAt = Date.now();
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 360, errorCorrectionLevel: 'H' });
      } catch (err) {
        console.error('[whatsapp] qr encode failed:', err.message);
      }
      this.status = 'awaiting_qr';
      // We're now waiting on a human to scan — that can legitimately take a
      // while, so stand the watchdog down until they authenticate.
      this._clearWatchdog();
      console.log('[whatsapp] QR ready — scan within 60 seconds');
      activity.log(null, 'whatsapp_qr', 'QR generated — awaiting scan');
      this.emit('qr', this.qrDataUrl);
    });

    this.client.on('loading_screen', (percent, message) => {
      this.status = 'loading';
      // Loading has begun but can silently wedge — (re)arm the watchdog so a
      // stalled load is recovered instead of hanging on the loading screen.
      this._armWatchdog();
      console.log(`[whatsapp] loading ${percent}% — ${message}`);
    });

    this.client.on('authenticated', () => {
      this.status = 'authenticated';
      this.qrDataUrl = null;
      this.qrRaw = null;
      // Authenticated (fresh scan or restored session); now we wait for `ready`.
      // Give that phase its own watchdog window — this is exactly where a
      // corrupt post-reboot session stalls.
      this._armWatchdog();
      console.log('[whatsapp] authenticated');
      activity.log(null, 'whatsapp_auth', 'WhatsApp authenticated');
    });

    this.client.on('auth_failure', (msg) => {
      this.status = 'auth_failed';
      this.lastError = String(msg);
      this._clearWatchdog();
      console.error('[whatsapp] auth_failure:', msg);
      activity.log(null, 'whatsapp_auth_failed', String(msg));
      this.client = null;
      // Bad credentials won't fix themselves on retry — count this toward the
      // session-reset threshold so a corrupt session gets wiped.
      this._consecutiveFailures += 1;
      this.scheduleReconnect(20_000);
    });

    this.client.on('ready', () => {
      this.status = 'ready';
      this.qrDataUrl = null;
      this.qrRaw = null;
      this.lastError = null;
      // Healthy again — disarm the watchdog and reset the failure counters so a
      // future disconnect gets a full set of fresh retries.
      this._clearWatchdog();
      this._reconnectCount = 0;
      this._consecutiveFailures = 0;
      console.log('[whatsapp] ✓ client ready — listening for media messages');
      activity.log(null, 'whatsapp_ready', 'WhatsApp client ready');
      this.emit('ready');
    });

    this.client.on('disconnected', (reason) => {
      this.status = 'disconnected';
      this.lastError = String(reason);
      this._clearWatchdog();
      console.warn('[whatsapp] disconnected:', reason);
      activity.log(null, 'whatsapp_disconnected', String(reason));
      this.client = null;
      this.scheduleReconnect(15_000);
    });

    this.client.on('message', (msg) => {
      this.handleMessage(msg).catch((err) => {
        console.error('[whatsapp] message handler error:', err.message);
      });
    });

    // Also capture media the operator shares with THEMSELVES — i.e. files sent
    // into the "Message yourself" chat. `message` only fires for messages from
    // other people; `message_create` also fires for your own. We keep just the
    // self-chat media (so we don't import normal outgoing replies to customers,
    // and don't double-handle the incoming messages already covered above).
    this.client.on('message_create', (msg) => {
      this.handleSelfMessage(msg).catch((err) => {
        console.error('[whatsapp] self-message handler error:', err.message);
      });
    });

    // Arm the watchdog around the whole connect handshake. initialize()
    // resolves once the browser is up, but `ready` can still never arrive on a
    // wedged session — the watchdog is what unsticks that case.
    this._armWatchdog();

    try {
      await this.client.initialize();
    } catch (err) {
      this.status = 'error';
      this.lastError = err.message;
      this._clearWatchdog();
      console.error('[whatsapp] init error:', err.message);
      this.client = null;
      this._consecutiveFailures += 1;
      this.scheduleReconnect(20_000);
    }
  }

  // Arm (or re-arm) the ready watchdog. Fires once if we linger in any
  // non-ready, non-QR state past READY_TIMEOUT_MS.
  _armWatchdog(ms = READY_TIMEOUT_MS) {
    this._clearWatchdog();
    this._readyWatchdog = setTimeout(() => {
      this._readyWatchdog = null;
      if (this.status === 'ready' || this.status === 'awaiting_qr') return;
      this._consecutiveFailures += 1;
      this._forceReconnect(`stuck at "${this.status}" for ${Math.round(ms / 1000)}s`);
    }, ms);
    // Don't let the watchdog keep the event loop alive on its own.
    if (this._readyWatchdog.unref) this._readyWatchdog.unref();
  }

  _clearWatchdog() {
    if (this._readyWatchdog) {
      clearTimeout(this._readyWatchdog);
      this._readyWatchdog = null;
    }
  }

  // Tear the wedged client down cleanly, then schedule a fresh start. After a
  // few failures in a row, wipe the saved session so we recover from corruption.
  async _forceReconnect(reason) {
    console.warn(`[whatsapp] watchdog: ${reason} — restarting client`);
    activity.log(null, 'whatsapp_watchdog', reason);
    this._clearWatchdog();
    const dead = this.client;
    this.client = null;
    this.status = 'reconnecting';
    if (dead) {
      try { await dead.destroy(); } catch (e) { /* already gone */ }
    }
    this.scheduleReconnect(4_000);
  }

  // Remove the LocalAuth session so the next start() yields a new QR. Only safe
  // once the client owning the Chromium profile has been destroyed.
  _clearSession() {
    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      console.warn('[whatsapp] cleared saved session — a fresh QR will be required');
      activity.log(null, 'whatsapp_session_reset', 'Corrupt session cleared — rescan QR');
      this._consecutiveFailures = 0;
    } catch (e) {
      console.error('[whatsapp] could not clear session:', e.message);
    }
  }

  scheduleReconnect(delay = 10_000) {
    if (this._reconnecting) return;
    // Repeated failures usually mean a corrupt restored session (the common
    // "stuck after reboot" cause). Wipe it so the next start forces a fresh QR
    // and reset the attempt counter for a clean slate.
    if (this._consecutiveFailures >= SESSION_RESET_AFTER) {
      this._clearSession();
      this._reconnectCount = 0;
    }
    if (this._reconnectCount >= 5) {
      console.error('[whatsapp] max reconnect attempts reached — giving up. Restart the server to retry.');
      this.status = 'failed';
      return;
    }
    this._reconnecting = true;
    this._reconnectCount += 1;
    console.log(`[whatsapp] reconnecting in ${delay / 1000}s… (attempt ${this._reconnectCount}/5)`);
    setTimeout(() => {
      this._reconnecting = false;
      this.start().catch((e) => console.error('[whatsapp] reconnect failed:', e.message));
    }, delay);
  }

  // Decide whether a `message_create` event is a file the operator dropped into
  // their own "Message yourself" chat, and if so import it. We ask WhatsApp
  // whether the chat's contact *is the logged-in account* (`isMe`) rather than
  // matching phone numbers — WhatsApp now addresses the self-chat by a hidden id
  // (`@lid`, e.g. 140995203211430) that does NOT equal your phone number, so a
  // number comparison wrongly rejects it. The `isMe` flag is true regardless of
  // phone-vs-@lid addressing.
  async handleSelfMessage(msg) {
    if (!msg.fromMe || !msg.hasMedia) return;

    let isSelf = false;
    let chatId = null;
    let chatName = null;
    let isGroup = null;
    try {
      const chat = await msg.getChat();
      if (chat) {
        chatId = chat.id?._serialized;
        chatName = chat.name;
        isGroup = chat.isGroup;
        if (!chat.isGroup) {
          const contact = await chat.getContact();
          isSelf = !!(contact && contact.isMe);
        }
      }
    } catch (err) {
      console.error('[whatsapp] self-chat detect failed:', err.message);
    }

    console.log(`[whatsapp] outgoing media: chat=${chatId} name=${chatName} group=${isGroup} self=${isSelf}`);
    if (!isSelf) return; // only the "Message yourself" chat

    console.log('[whatsapp] importing self-shared media');
    return this.handleMessage(msg);
  }

  async handleMessage(msg) {
    if (!msg.hasMedia) return;

    const ext = this._mimeToExt(msg.type);
    if (!ext || !config.allowedExtensions.includes(ext)) {
      console.log('[whatsapp] skipping unsupported type:', msg.type);
      return;
    }

    const key = msg.id?._serialized || `${msg.from}-${Date.now()}`;
    const attempts = this.attempts.get(key) || 0;

    try {
      const mediaPayload = await msg.downloadMedia();
      if (!mediaPayload || !mediaPayload.data) {
        throw new Error('empty media payload');
      }

      const buffer = Buffer.from(mediaPayload.data, 'base64');
      const contact = await msg.getContact().catch(() => null);
      const customerName = contact?.pushname || contact?.name || null;
      const customerPhone = (msg.from || '').split('@')[0].split(':')[0];
      const originalName = mediaPayload.filename || guessName(mediaPayload.mimetype);

      const result = await media.saveIncoming({
        buffer,
        originalName,
        mimeType: mediaPayload.mimetype,
        customerName,
        customerPhone,
        source: 'whatsapp',
      });

      this.attempts.delete(key);
      if (result.ok) {
        console.log(`[whatsapp] imported: ${originalName} from ${customerName || customerPhone}`);
      } else {
        console.log(`[whatsapp] skipped: ${result.reason} — ${originalName}`);
      }
      this.emit('imported', result);
    } catch (err) {
      const next = attempts + 1;
      this.attempts.set(key, next);
      activity.log(null, 'import_error', `attempt ${next}/3: ${err.message}`);
      console.error(`[whatsapp] import attempt ${next}/3 failed:`, err.message);
      if (next < 3) {
        setTimeout(() => this.handleMessage(msg), 5_000);
      } else {
        this.attempts.delete(key);
        activity.log(null, 'import_failed', `gave up after 3 attempts: ${err.message}`);
      }
    }
  }

  _mimeToExt(type) {
    const map = {
      image: '.jpg',
      document: '.pdf',
      video: null,
      audio: null,
      sticker: null,
    };
    return map[type] !== undefined ? map[type] : '.bin';
  }
}

function guessName(mime) {
  if (!mime) return 'file.bin';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'photo.jpg';
  if (mime.includes('png')) return 'image.png';
  if (mime.includes('pdf')) return 'document.pdf';
  if (mime.includes('word') || mime.includes('docx')) return 'document.docx';
  return 'file.bin';
}

module.exports = new WhatsAppService();
