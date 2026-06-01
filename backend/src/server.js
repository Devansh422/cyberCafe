const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./lib/config');
const { init: initDb } = require('./db/index');

const app = express();

app.use(cors({ origin: config.allowedOrigin }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

initDb().then(() => {
  const jobsRouter = require('./routes/jobs');
  const systemRouter = require('./routes/system');
  const passportRouter = require('./routes/passport');
  const whatsapp = require('./services/whatsapp');
  const cleanup = require('./services/cleanup');

  app.use('/api/jobs', jobsRouter);
  app.use('/api/system', systemRouter);
  app.use('/api/passport', passportRouter);

  app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message || 'internal_error' });
  });

  const port = config.port;
  const server = app.listen(port, () => {
    console.log(`[ratan-backend] listening on http://localhost:${port}`);
    console.log(`[ratan-backend] media root: ${config.mediaRoot}`);
    if (config.whatsappEnabled) {
      whatsapp.start().catch((err) => console.error('[whatsapp] start error:', err.message));
    } else {
      console.log('[whatsapp] disabled via env');
    }
    cleanup.start();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // A previous backend (or a duplicate PM2/manual start) already owns the
      // port. Restarting in a loop just spawns more processes — exit clearly.
      console.error(
        `[fatal] Port ${port} is already in use. Another Ratan backend is likely already running.\n` +
          `        Fix:  pm2 delete all   (then)  pm2 start ecosystem.config.js\n` +
          `        Or close the other process holding port ${port}.`,
      );
    } else {
      console.error('[fatal] server error:', err.message);
    }
    process.exit(1);
  });
}).catch((err) => {
  console.error('[fatal] DB init failed:', err);
  process.exit(1);
});
