const express = require('express');
const whatsapp = require('../services/whatsapp');
const printSvc = require('../services/print');
const processing = require('../services/processing');
const diagnostics = require('../services/diagnostics');
const activity = require('../db/activity');
const jobsDb = require('../db/jobs');

const router = express.Router();

router.get('/status', async (req, res) => {
  res.json({
    whatsapp: whatsapp.getState(),
    counts: jobsDb.countByStatus(),
    presets: processing.presetList(),
    queue: printSvc.getQueueSnapshot(),
  });
});

router.get('/whatsapp/qr', (req, res) => {
  const state = whatsapp.getState();
  res.json(state);
});

router.post('/whatsapp/start', async (req, res) => {
  try {
    await whatsapp.start();
    res.json(whatsapp.getState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/printers', async (req, res) => {
  const list = await printSvc.listPrinters();
  res.json(list);
});

// Operator "Kill process": clear the print queue, kill the print engine, and
// reset anything stuck mid-print. Used by the control-panel kill buttons.
router.post('/cancel', async (req, res) => {
  try {
    const result = await printSvc.cancelAll();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
  res.json(activity.list(limit));
});

router.get('/diagnostics', async (req, res) => {
  try {
    res.json(await diagnostics.run());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
