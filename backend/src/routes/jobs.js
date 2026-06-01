const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const jobsDb = require('../db/jobs');
const media = require('../services/media');
const processing = require('../services/processing');
const printSvc = require('../services/print');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.get('/', (req, res) => {
  const { status, limit = '100', offset = '0' } = req.query;
  const jobs = jobsDb.listJobs({
    status: status || undefined,
    limit: parseInt(limit, 10),
    offset: parseInt(offset, 10),
  });
  res.json({ jobs, counts: jobsDb.countByStatus() });
});

router.get('/counts', (req, res) => {
  res.json(jobsDb.countByStatus());
});

router.get('/:id', (req, res) => {
  const job = jobsDb.getJob(parseInt(req.params.id, 10));
  if (!job) return res.status(404).json({ error: 'not_found' });
  res.json(job);
});

router.get('/:id/file', (req, res) => {
  const job = jobsDb.getJob(parseInt(req.params.id, 10));
  if (!job) return res.status(404).end();
  const which = req.query.processed === '1' && job.processed_path ? job.processed_path : media.absolutePath(job.storage_folder, job.filename);
  if (!fs.existsSync(which)) return res.status(404).end();
  res.sendFile(path.resolve(which));
});

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const result = await media.saveIncoming({
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    customerName: req.body.customer || 'walk-in',
    customerPhone: req.body.phone || null,
    source: 'upload',
  });
  if (!result.ok) return res.status(409).json(result);
  res.status(201).json(result.job);
});

router.post('/:id/process', async (req, res) => {
  try {
    const job = await processing.processJob(parseInt(req.params.id, 10), req.body.preset || 'scan_pdf');
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/print', async (req, res) => {
  const job = jobsDb.getJob(parseInt(req.params.id, 10));
  if (!job) return res.status(404).json({ error: 'not_found' });
  const result = printSvc.enqueue(job.id, {
    preset: req.body.preset || null,
    printer: req.body.printer || null,
    copies: req.body.copies || 1,
    orientation: req.body.orientation || null,
    paperSize: req.body.paperSize || null,
    grayscale: !!req.body.grayscale,
  });
  res.json({ ...result, jobId: job.id });
});

// ---- Manual batch merge -----------------------------------------------------
// Combine the operator-selected processed items into a single printable PDF.
// Returns the new merged job, which then prints like any other processed item.
router.post('/merge', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((n) => parseInt(n, 10)).filter(Boolean) : [];
  if (ids.length < 1) return res.status(400).json({ error: 'select at least one item' });
  try {
    const job = await processing.mergeJobsToPdf(ids, { preset: req.body.preset || 'scan_pdf' });
    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Batch operations -------------------------------------------------------
// A batch groups files a customer sent at once. These endpoints act on every
// job in the batch while individual-item endpoints above keep working too.

router.post('/batch/:batchId/process', async (req, res) => {
  const jobs = jobsDb.listByBatch(req.params.batchId);
  if (!jobs.length) return res.status(404).json({ error: 'batch_not_found' });
  const preset = req.body.preset || 'scan_pdf';
  const results = [];
  for (const job of jobs) {
    if (job.status !== 'incoming' && job.status !== 'failed') continue;
    try {
      results.push(await processing.processJob(job.id, preset));
    } catch (err) {
      results.push({ id: job.id, error: err.message });
    }
  }
  res.json({ ok: true, processed: results.length, jobs: results });
});

router.post('/batch/:batchId/print', async (req, res) => {
  const jobs = jobsDb.listByBatch(req.params.batchId);
  if (!jobs.length) return res.status(404).json({ error: 'batch_not_found' });
  let queued = 0;
  for (const job of jobs) {
    printSvc.enqueue(job.id, {
      preset: req.body.preset || null,
      printer: req.body.printer || null,
      copies: req.body.copies || 1,
      orientation: req.body.orientation || null,
      paperSize: req.body.paperSize || null,
      grayscale: !!req.body.grayscale,
    });
    queued += 1;
  }
  res.json({ ok: true, queued });
});

router.delete('/batch/:batchId', async (req, res) => {
  const jobs = jobsDb.listByBatch(req.params.batchId);
  if (!jobs.length) return res.status(404).json({ error: 'batch_not_found' });
  let deleted = 0;
  for (const job of jobs) {
    await media.deleteJobFiles(job).catch(() => {});
    jobsDb.deleteJob(job.id);
    deleted += 1;
  }
  res.json({ ok: true, deleted });
});

// Bulk delete every job in a given status (e.g. clear all incoming). Files are
// removed from the media center too. Status is required to avoid wiping the DB.
router.delete('/', async (req, res) => {
  const status = req.query.status;
  if (!status) return res.status(400).json({ error: 'status query param required' });
  const jobs = jobsDb.listJobs({ status, limit: 100000 });
  let deleted = 0;
  for (const job of jobs) {
    await media.deleteJobFiles(job).catch(() => {});
    jobsDb.deleteJob(job.id);
    deleted += 1;
  }
  res.json({ ok: true, deleted });
});

router.delete('/:id', async (req, res) => {
  const job = jobsDb.getJob(parseInt(req.params.id, 10));
  if (!job) return res.status(404).json({ error: 'not_found' });
  await media.deleteJobFiles(job).catch(() => {});
  jobsDb.deleteJob(job.id);
  res.json({ ok: true });
});

module.exports = router;
