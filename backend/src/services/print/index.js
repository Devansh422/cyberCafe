const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const config = require('../../lib/config');
const jobsDb = require('../../db/jobs');
const activity = require('../../db/activity');
const { runPowerShell, runHidden } = require('../../lib/win-exec');

let printer = null;
try { printer = require('pdf-to-printer'); } catch { /* installed lazily */ }

const queue = [];
let processing = false;

// Cache the printer list so we don't spawn a PowerShell process on every
// dashboard click / SWR revalidation. The list almost never changes mid-shift.
const PRINTER_CACHE_MS = 30_000;
let printerCache = { at: 0, list: null };

/**
 * List installed Windows printers WITHOUT flashing a console window.
 *
 * pdf-to-printer's own getPrinters() calls `Powershell.exe` via execFile with
 * the default `windowsHide: false`, which pops a visible window each time. We
 * run the same query through our hidden helper and return JSON, then cache it.
 */
async function listPrinters({ force = false } = {}) {
  const now = Date.now();
  if (!force && printerCache.list && now - printerCache.at < PRINTER_CACHE_MS) {
    return printerCache.list;
  }
  try {
    const { stdout } = await runPowerShell(
      "Get-CimInstance Win32_Printer | Select-Object DeviceID,Name,@{n='paperSizes';e={$_.PrinterPaperNames}} | ConvertTo-Json -Compress",
    );
    const list = normalizePrinters(stdout);
    printerCache = { at: now, list };
    return list;
  } catch (err) {
    console.error('[print] listPrinters failed:', err.message);
    // Serve a stale cache if we have one rather than an empty dropdown.
    return printerCache.list || [];
  }
}

function normalizePrinters(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr
    .filter((p) => p && (p.Name || p.DeviceID))
    .map((p) => {
      // ConvertTo-Json renders an array property as either a bare array or a
      // wrapped { value: [...] } object depending on PowerShell version.
      let paperSizes = p.paperSizes;
      if (paperSizes && !Array.isArray(paperSizes) && Array.isArray(paperSizes.value)) {
        paperSizes = paperSizes.value;
      }
      return {
        deviceId: p.DeviceID || p.Name,
        name: p.Name || p.DeviceID,
        paperSizes: Array.isArray(paperSizes) ? paperSizes : [],
      };
    });
}

function enqueue(jobId, options = {}) {
  queue.push({ jobId, options });
  pump();
  return { queued: queue.length };
}

function getQueueSnapshot() {
  return queue.map((item) => ({ jobId: item.jobId, printer: item.options.printer || null }));
}

async function pump() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const item = queue.shift();
    try {
      await runPrint(item.jobId, item.options);
    } catch (err) {
      console.error('[print] job failed:', err.message);
    }
  }
  processing = false;
}

async function runPrint(jobId, options) {
  const job = jobsDb.getJob(jobId);
  if (!job) throw new Error('job not found');

  // Printing now requires an already-processed PDF. The dynamic CTA in the UI
  // guarantees an item is processed before its Print action is offered, so a
  // missing render here is a real error rather than something to silently fix.
  const pdfPath = job.processed_path;
  if (!pdfPath || !fs.existsSync(pdfPath) || !pdfPath.toLowerCase().endsWith('.pdf')) {
    jobsDb.updateJob(jobId, { status: 'failed', error: 'process to PDF before printing' });
    activity.log(jobId, 'print_failed', 'not processed — process to PDF before printing');
    return;
  }

  jobsDb.updateJob(jobId, { status: 'printing', printer: options.printer || null, copies: options.copies || 1 });
  activity.log(jobId, 'printing', `→ ${options.printer || 'default'}`);

  if (!printer) {
    jobsDb.updateJob(jobId, { status: 'failed', error: 'pdf-to-printer not installed' });
    activity.log(jobId, 'print_failed', 'pdf-to-printer missing');
    return;
  }

  try {
    const printOpts = {};
    if (options.printer) printOpts.printer = options.printer;
    if (options.copies) printOpts.copies = options.copies;
    if (options.orientation) printOpts.orientation = options.orientation;
    if (options.paperSize) printOpts.paperSize = options.paperSize;
    if (options.grayscale) printOpts.monochrome = true;

    await printer.print(pdfPath, printOpts);

    const printedDir = path.join(config.mediaRoot, config.folders.printed);
    await fsp.mkdir(printedDir, { recursive: true });
    const printedPath = path.join(printedDir, path.basename(pdfPath));
    await fsp.copyFile(pdfPath, printedPath).catch(() => {});

    jobsDb.updateJob(jobId, {
      status: 'printed',
      printed_at: new Date().toISOString(),
    });
    activity.log(jobId, 'printed', `via ${options.printer || 'default'}`);
  } catch (err) {
    jobsDb.updateJob(jobId, { status: 'failed', error: err.message });
    activity.log(jobId, 'print_failed', err.message);
  }
}

// Immediately stop everything: drop the pending queue, kill the spawned print
// engine (SumatraPDF, which pdf-to-printer shells out to), and reset any job
// left in 'printing' so the UI never shows a frozen task. Backs the operator's
// "Kill process" button. Best-effort: a missing process to kill is not an error.
async function cancelAll() {
  const cleared = queue.length;
  queue.length = 0; // drop everything still pending

  let killed = false;
  try {
    // Kill by the bundled binary's real image name (it is versioned, e.g.
    // SumatraPDF-3.4.6-64.exe), falling back to the plain name.
    const sumatra = sumatraPath();
    const imageName = sumatra ? path.basename(sumatra) : 'SumatraPDF.exe';
    await runHidden('taskkill', ['/F', '/T', '/IM', imageName]);
    killed = true;
  } catch {
    /* nothing printing right now — fine */
  }

  // Reset anything mid-print: the kill above made its print() reject, but the
  // status row may still read 'printing'. Mark it failed so it can be retried.
  let reset = 0;
  for (const job of jobsDb.listJobs({ status: 'printing', limit: 100000 })) {
    jobsDb.updateJob(job.id, { status: 'failed', error: 'cancelled by operator' });
    activity.log(job.id, 'print_cancelled', 'killed by operator');
    reset += 1;
  }

  processing = false;
  activity.log(null, 'queue_cancelled', `Cleared ${cleared} queued · print engine killed · ${reset} reset`);
  return { cleared, killed, reset };
}

// Path to the bundled SumatraPDF binary that pdf-to-printer ships with —
// used by diagnostics to confirm the print engine is present.
function sumatraPath() {
  try {
    const dist = path.dirname(require.resolve('pdf-to-printer'));
    const candidates = fs.readdirSync(dist).filter((f) => /^SumatraPDF.*\.exe$/i.test(f));
    if (candidates.length) return path.join(dist, candidates[0]);
  } catch { /* not installed */ }
  return null;
}

module.exports = { listPrinters, enqueue, getQueueSnapshot, cancelAll, sumatraPath, printerModuleLoaded: () => !!printer };
