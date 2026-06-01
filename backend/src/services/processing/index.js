const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../../lib/config');
const media = require('../media');
const jobsDb = require('../../db/jobs');
const activity = require('../../db/activity');

let sharp = null;
let PDFDocument = null;
try { sharp = require('sharp'); } catch { /* installed lazily */ }
try { ({ PDFDocument } = require('pdf-lib')); } catch { /* installed lazily */ }

const A4 = { widthPt: 595.28, heightPt: 841.89, widthPx: 2480, heightPx: 3508 };

const PRESETS = {
  scan_pdf: { grayscale: true, sharpen: true, contrast: 1.2, brightness: 1.05, fit: 'A4', output: 'pdf' },
  bw: { grayscale: true, sharpen: false, fit: 'A4', output: 'pdf' },
  color: { grayscale: false, sharpen: true, fit: 'A4', output: 'pdf' },
  high_contrast: { grayscale: true, contrast: 1.4, brightness: 1.1, sharpen: true, fit: 'A4', output: 'pdf' },
  a4_resize: { grayscale: false, sharpen: false, fit: 'A4', output: 'pdf' },
};

function presetList() {
  return Object.keys(PRESETS);
}

async function processImageToPdf(srcPath, destPath, preset) {
  if (!sharp || !PDFDocument) {
    throw new Error('image/pdf libraries unavailable — run npm install in /backend');
  }

  let pipeline = sharp(srcPath).rotate();

  if (preset.fit === 'A4') {
    pipeline = pipeline.resize(A4.widthPx, A4.heightPx, { fit: 'contain', background: { r: 255, g: 255, b: 255 } });
  }

  if (preset.grayscale) pipeline = pipeline.grayscale();
  if (preset.brightness || preset.contrast) {
    pipeline = pipeline.modulate({ brightness: preset.brightness || 1 }).linear(preset.contrast || 1, 0);
  }
  if (preset.sharpen) pipeline = pipeline.sharpen();

  const imgBuf = await pipeline.png().toBuffer();

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([A4.widthPt, A4.heightPt]);
  const png = await pdf.embedPng(imgBuf);
  const scale = Math.min(A4.widthPt / png.width, A4.heightPt / png.height);
  const w = png.width * scale;
  const h = png.height * scale;
  page.drawImage(png, {
    x: (A4.widthPt - w) / 2,
    y: (A4.heightPt - h) / 2,
    width: w,
    height: h,
  });
  const bytes = await pdf.save();
  await fsp.writeFile(destPath, bytes);
  return { pages: 1 };
}

async function copyPdf(srcPath, destPath) {
  await fsp.copyFile(srcPath, destPath);
  if (!PDFDocument) return { pages: 1 };
  try {
    const buf = await fsp.readFile(srcPath);
    const pdf = await PDFDocument.load(buf);
    return { pages: pdf.getPageCount() };
  } catch {
    return { pages: 1 };
  }
}

async function processJob(jobId, presetName = 'scan_pdf') {
  const job = jobsDb.getJob(jobId);
  if (!job) throw new Error('job not found');

  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`unknown preset ${presetName}`);

  const src = media.absolutePath(job.storage_folder, job.filename);
  if (!fs.existsSync(src)) throw new Error(`source file missing: ${src}`);

  const destName = job.filename.replace(/\.[^.]+$/, '') + `.${presetName}.pdf`;
  const destDir = path.join(config.mediaRoot, config.folders.processed);
  await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, destName);

  let pageInfo = { pages: 1 };
  try {
    if (job.type === 'image') {
      pageInfo = await processImageToPdf(src, dest, preset);
    } else if (job.type === 'pdf') {
      pageInfo = await copyPdf(src, dest);
    } else {
      throw new Error(`unsupported job type for processing: ${job.type}`);
    }

    const updated = jobsDb.updateJob(jobId, {
      status: 'processed',
      processed_path: dest,
      preset: presetName,
      pages: pageInfo.pages,
    });
    activity.log(jobId, 'processed', `Preset ${presetName} → ${destName}`);
    return updated;
  } catch (err) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    jobsDb.updateJob(jobId, { status: 'failed', error: err.message });
    activity.log(jobId, 'process_failed', err.message);
    throw err;
  }
}

// ---- Manual batch merge -----------------------------------------------------
// Combine several already-processed jobs into ONE printable PDF. Any selected
// item that isn't a rendered PDF yet is processed on the fly first so the merge
// never fails on a half-ready item. Returns a brand-new processed job that
// represents the merged sheet (the source items are left untouched).
async function mergeJobsToPdf(ids, { preset = 'scan_pdf' } = {}) {
  if (!PDFDocument) throw new Error('pdf-lib unavailable — run npm install in /backend');
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('no items selected');

  const sources = [];
  for (const id of ids) {
    let job = jobsDb.getJob(id);
    if (!job) continue;
    const ready =
      job.processed_path &&
      fs.existsSync(job.processed_path) &&
      job.processed_path.toLowerCase().endsWith('.pdf');
    if (!ready) {
      job = await processJob(id, job.preset || preset);
    }
    sources.push(job);
  }
  if (!sources.length) throw new Error('no valid items to merge');

  const merged = await PDFDocument.create();
  let pageCount = 0;
  for (const job of sources) {
    const buf = await fsp.readFile(job.processed_path);
    const doc = await PDFDocument.load(buf);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const p of pages) {
      merged.addPage(p);
      pageCount += 1;
    }
  }
  const bytes = await merged.save();

  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const destName = `batch_${ts}_${sources.length}items.pdf`;
  const destDir = path.join(config.mediaRoot, config.folders.processed);
  await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, destName);
  await fsp.writeFile(dest, Buffer.from(bytes));

  const batchId = crypto.randomUUID();
  const created = jobsDb.createJob({
    filename: destName,
    original_name: `Batch of ${sources.length} files`,
    type: 'pdf',
    mime_type: 'application/pdf',
    size: bytes.length,
    customer_name: sources[0].customer_name || 'Batch',
    customer_phone: sources[0].customer_phone || null,
    status: 'processed',
    source: 'batch',
    storage_folder: config.folders.processed,
    batch_id: batchId,
  });
  const job = jobsDb.updateJob(created.id, { processed_path: dest, preset: 'merge', pages: pageCount });
  activity.log(job.id, 'batch_created', `Merged ${sources.length} item(s) → ${destName}`);
  return job;
}

module.exports = { processJob, mergeJobsToPdf, presetList, PRESETS };
