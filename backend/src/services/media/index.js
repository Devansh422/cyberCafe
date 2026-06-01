const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../../lib/config');
const jobsDb = require('../../db/jobs');
const activity = require('../../db/activity');

function ensureFolders() {
  for (const folder of Object.values(config.folders)) {
    fs.mkdirSync(path.join(config.mediaRoot, folder), { recursive: true });
  }
}

ensureFolders();

function sanitize(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);
}

function timestampSlug(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function buildFilename({ customer, originalName }) {
  const safeCustomer = sanitize(customer || 'unknown');
  const safeName = sanitize(originalName || 'file');
  return `${timestampSlug()}_${safeCustomer}_${safeName}`;
}

function typeFromExtension(ext) {
  const e = ext.toLowerCase();
  if (['.jpg', '.jpeg', '.png'].includes(e)) return 'image';
  if (e === '.pdf') return 'pdf';
  if (e === '.docx') return 'docx';
  return 'other';
}

function isAllowed(ext) {
  const e = ext.toLowerCase();
  if (config.blockedExtensions.includes(e)) return false;
  return config.allowedExtensions.includes(e);
}

async function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Files a customer sends "at once" (multiple images within this window) are
// grouped into one batch so the operator can process/print them together while
// still being able to act on each item individually.
const BATCH_WINDOW_MS = 10_000;

// SQLite stores created_at as UTC text ("YYYY-MM-DD HH:MM:SS"). Parse it back to
// epoch millis so we can measure how long ago a job arrived.
function sqliteTimeToMs(ts) {
  if (!ts) return 0;
  const ms = Date.parse(ts.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? 0 : ms;
}

// Decide which batch (if any) a newly arrived image belongs to. Chains images
// that each land within BATCH_WINDOW_MS of the previous one from the same
// customer. Returns the batch id to stamp on the new job, creating one (and
// back-filling the lone earlier image) on the second image of a burst.
function resolveBatchId(type, customerKey) {
  if (type !== 'image' || !customerKey) return null;
  const mate = jobsDb.findRecentIncomingImage(customerKey);
  if (!mate) return null;
  if (Date.now() - sqliteTimeToMs(mate.created_at) > BATCH_WINDOW_MS) return null;
  if (mate.batch_id) return mate.batch_id;
  const batchId = crypto.randomUUID();
  jobsDb.updateJob(mate.id, { batch_id: batchId });
  return batchId;
}

function folderPath(folder) {
  return path.join(config.mediaRoot, folder);
}

function absolutePath(folder, filename) {
  return path.join(folderPath(folder), filename);
}

async function saveIncoming({ buffer, originalName, mimeType, customerName, customerPhone, source = 'whatsapp' }) {
  const ext = path.extname(originalName || '').toLowerCase() || '.bin';
  if (!isAllowed(ext)) {
    activity.log(null, 'rejected', `Unsupported file type ${ext} from ${customerName || customerPhone || 'unknown'}`);
    return { ok: false, reason: 'unsupported_extension' };
  }

  const hash = await hashBuffer(buffer);
  const duplicate = jobsDb.findDuplicate(hash);
  if (duplicate) {
    activity.log(duplicate.id, 'duplicate', `Duplicate of #${duplicate.id} (${duplicate.filename})`);
    return { ok: false, reason: 'duplicate', job: duplicate };
  }

  const filename = buildFilename({ customer: customerName || customerPhone, originalName });
  const target = absolutePath(config.folders.incoming, filename);
  await fsp.writeFile(target, buffer);

  const type = typeFromExtension(ext);
  const batchId = resolveBatchId(type, customerPhone || customerName);

  const job = jobsDb.createJob({
    filename,
    original_name: originalName,
    type,
    mime_type: mimeType || null,
    size: buffer.length,
    hash,
    customer_name: customerName || null,
    customer_phone: customerPhone || null,
    status: 'incoming',
    source,
    storage_folder: config.folders.incoming,
    batch_id: batchId,
  });

  activity.log(job.id, 'imported', `Imported ${filename} (${buffer.length} bytes)`);
  return { ok: true, job };
}

async function moveJob(job, toFolder) {
  const from = absolutePath(job.storage_folder, job.filename);
  const to = absolutePath(toFolder, job.filename);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return jobsDb.updateJob(job.id, { storage_folder: toFolder });
}

async function deleteJobFiles(job) {
  const main = absolutePath(job.storage_folder, job.filename);
  await fsp.rm(main, { force: true });
  if (job.processed_path) {
    await fsp.rm(job.processed_path, { force: true });
  }
}

function statFile(job) {
  try {
    const p = absolutePath(job.storage_folder, job.filename);
    return fs.statSync(p);
  } catch {
    return null;
  }
}

module.exports = {
  ensureFolders,
  saveIncoming,
  moveJob,
  deleteJobFiles,
  absolutePath,
  folderPath,
  buildFilename,
  isAllowed,
  typeFromExtension,
  statFile,
};
