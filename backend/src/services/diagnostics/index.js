const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const config = require('../../lib/config');
const printSvc = require('../print');
const whatsapp = require('../whatsapp');

/**
 * Diagnostics pipeline.
 *
 * Each check returns { id, label, status, detail, fix } where:
 *   status = 'ok' | 'warn' | 'error'
 *   detail = human-readable description of the current state
 *   fix    = concrete remediation steps when not ok (null when ok)
 *
 * The dashboard renders these so the operator can self-diagnose without
 * reading logs. Every check is wrapped so one failure can't break the report.
 */

function ok(id, label, detail) {
  return { id, label, status: 'ok', detail, fix: null };
}
function warn(id, label, detail, fix) {
  return { id, label, status: 'warn', detail, fix };
}
function fail(id, label, detail, fix) {
  return { id, label, status: 'error', detail, fix };
}

async function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) return ok('node', 'Node.js runtime', `Node ${process.version}`);
  return fail(
    'node',
    'Node.js runtime',
    `Node ${process.version} is too old`,
    'Install Node.js 18 LTS or newer from https://nodejs.org, then reinstall dependencies.',
  );
}

async function checkMediaFolders() {
  const missing = [];
  for (const folder of Object.values(config.folders)) {
    const dir = path.join(config.mediaRoot, folder);
    if (!fs.existsSync(dir)) missing.push(folder);
  }
  if (!missing.length) {
    // Confirm we can actually write (read-only folder / permissions issue).
    try {
      const probe = path.join(config.mediaRoot, config.folders.temp, `.diag-${Date.now()}`);
      await fsp.writeFile(probe, 'ok');
      await fsp.unlink(probe).catch(() => {});
    } catch (err) {
      return fail(
        'media',
        'Media center folders',
        `Cannot write to ${config.mediaRoot}: ${err.message}`,
        'Check folder permissions, or that the drive is not full / read-only.',
      );
    }
    return ok('media', 'Media center folders', `All folders present under ${config.mediaRoot}`);
  }
  return fail(
    'media',
    'Media center folders',
    `Missing: ${missing.join(', ')}`,
    `Create them: in the project root run  mkdir media-center\\${missing.join(' media-center\\')}  (or restart the backend, which recreates them).`,
  );
}

async function checkDatabase() {
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) {
    return fail(
      'database',
      'Database',
      `DB folder missing: ${dir}`,
      'Restart the backend — it recreates the data folder and ratan.db automatically.',
    );
  }
  try {
    await fsp.access(dir, fs.constants.W_OK);
  } catch {
    return fail(
      'database',
      'Database',
      `DB folder not writable: ${dir}`,
      'Grant write permission to the data folder for the operator account.',
    );
  }
  const exists = fs.existsSync(config.dbPath);
  return ok('database', 'Database', exists ? 'ratan.db present and writable' : 'data folder writable (db created on first write)');
}

async function checkPrintEngine() {
  if (!printSvc.printerModuleLoaded()) {
    return fail(
      'print-engine',
      'Print engine',
      'pdf-to-printer module not loaded',
      'Run  npm install  inside the backend folder to install pdf-to-printer.',
    );
  }
  const sumatra = printSvc.sumatraPath();
  if (!sumatra || !fs.existsSync(sumatra)) {
    return fail(
      'print-engine',
      'Print engine',
      'Bundled SumatraPDF binary missing',
      'Reinstall the print engine:  npm install pdf-to-printer  in the backend folder.',
    );
  }
  return ok('print-engine', 'Print engine', `SumatraPDF ready (${path.basename(sumatra)})`);
}

async function checkPrinters() {
  try {
    const list = await printSvc.listPrinters();
    if (!list.length) {
      return warn(
        'printers',
        'Installed printers',
        'No printers detected',
        'Add a printer in Windows Settings → Bluetooth & devices → Printers & scanners, and set one as default.',
      );
    }
    return ok('printers', 'Installed printers', `${list.length} found: ${list.map((p) => p.name).join(', ')}`);
  } catch (err) {
    return fail('printers', 'Installed printers', err.message, 'Verify the Windows Print Spooler service is running (services.msc → Print Spooler → Start).');
  }
}

function findChrome() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Fall back to whatever puppeteer bundled.
  try {
    const puppeteer = require('puppeteer');
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch { /* puppeteer not resolvable */ }
  return null;
}

async function checkBrowser() {
  if (!config.whatsappEnabled) {
    return ok('browser', 'Browser engine (for WhatsApp)', 'WhatsApp disabled — browser not required');
  }
  const chrome = findChrome();
  if (!chrome) {
    return fail(
      'browser',
      'Browser engine (for WhatsApp)',
      'No Chrome/Edge/Chromium found — WhatsApp cannot start',
      'Install Google Chrome (https://google.com/chrome). WhatsApp Web automation needs a Chromium browser.',
    );
  }
  return ok('browser', 'Browser engine (for WhatsApp)', `Using ${path.basename(chrome)}`);
}

const WA_FIXES = {
  disabled: null,
  ready: null,
  authenticated: null,
  idle: 'Open the WhatsApp tab and click "Start / Refresh QR".',
  starting: 'Client is starting — wait a few seconds and refresh.',
  loading: 'Client is loading WhatsApp Web — wait for it to finish.',
  awaiting_qr: 'Open the WhatsApp tab and scan the QR with your phone (WhatsApp → Linked Devices → Link a Device) within 60 seconds.',
  auth_failed: 'Authentication failed. Delete backend\\.wwebjs_auth and re-link by scanning a fresh QR.',
  disconnected: 'WhatsApp disconnected. It auto-reconnects; if it does not, restart the backend or re-link the device.',
  error: 'WhatsApp failed to start. Confirm Chrome is installed and you have internet access, then restart the backend.',
  unavailable: 'whatsapp-web.js is not installed. Run  npm install  in the backend folder.',
  failed: 'WhatsApp gave up after repeated reconnect attempts. Restart the backend to retry, and delete backend\\.wwebjs_auth if the session is corrupt.',
};

async function checkWhatsApp() {
  const state = whatsapp.getState();
  if (!state.enabled) {
    return ok('whatsapp', 'WhatsApp connection', 'Disabled via WHATSAPP_ENABLED=false');
  }
  const detail = state.lastError ? `${state.status} — ${state.lastError}` : state.status;
  if (state.status === 'ready' || state.status === 'authenticated') {
    return ok('whatsapp', 'WhatsApp connection', `Connected (${state.status})`);
  }
  const fix = WA_FIXES[state.status] || 'Open the WhatsApp tab to check the connection and re-link if needed.';
  const status = ['failed', 'error', 'auth_failed', 'unavailable'].includes(state.status) ? 'error' : 'warn';
  return { id: 'whatsapp', label: 'WhatsApp connection', status, detail, fix };
}

const CHECKS = [
  checkNode,
  checkMediaFolders,
  checkDatabase,
  checkPrintEngine,
  checkPrinters,
  checkBrowser,
  checkWhatsApp,
];

async function run() {
  const results = [];
  for (const check of CHECKS) {
    try {
      results.push(await check());
    } catch (err) {
      results.push(fail(check.name, check.name, `check crashed: ${err.message}`, 'This is unexpected — check the backend logs.'));
    }
  }
  const summary = {
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    error: results.filter((r) => r.status === 'error').length,
  };
  const overall = summary.error ? 'error' : summary.warn ? 'warn' : 'ok';
  return { overall, summary, checks: results, generatedAt: new Date().toISOString() };
}

module.exports = { run };
