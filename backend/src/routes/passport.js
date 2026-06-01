const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const passport = require('../services/passport');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// MODNet / pipeline readiness — the UI shows a warning when matting is offline.
router.get('/status', (req, res) => {
  res.json(passport.status());
});

// Prepare one photo: background removal + composite over the chosen colour.
router.post('/prepare', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const result = await passport.prepare(req.file.buffer, { bg: req.body.bg });
    res.status(201).json({ ...result, previewUrl: `/api/passport/prepared/${result.id}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prepare a passport photo from an existing job (e.g. a WhatsApp incoming image).
router.post('/prepare-job', async (req, res) => {
  const jobId = parseInt(req.body.jobId, 10);
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  try {
    const result = await passport.prepareFromJob(jobId, { bg: req.body.bg });
    res.status(201).json({ ...result, previewUrl: `/api/passport/prepared/${result.id}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve a prepared (background-removed) photo for previewing.
router.get('/prepared/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9-]/gi, '');
  const file = passport.preparedPath(id);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  res.type('png');
  res.sendFile(path.resolve(file));
});

// Compose the 3×3 sheet from prepared photos and register it as a print job.
router.post('/sheet', async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'add at least one photo' });
  try {
    const job = await passport.createSheet(items, { bg: req.body.bg });
    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
