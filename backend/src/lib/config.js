const path = require('path');
require('dotenv').config();

const projectRoot = path.resolve(__dirname, '..', '..', '..');

const config = {
  // Backend listens on 5000; the Next.js frontend (PM2) runs on 4500 and proxies
  // /api → 5000 via next.config.js. Defaults match the PM2 deployment so a fresh
  // checkout works even without a backend/.env.
  port: parseInt(process.env.PORT || '5000', 10),
  mediaRoot: path.resolve(projectRoot, process.env.MEDIA_ROOT || 'media-center'),
  dbPath: path.resolve(__dirname, '..', '..', process.env.DB_PATH || 'data/ratan.db'),
  whatsappEnabled: process.env.WHATSAPP_ENABLED !== 'false',
  allowedOrigin: process.env.ALLOWED_ORIGIN || 'http://localhost:4500',
  // Completed (printed) jobs are auto-purged from the DB and media center this
  // many minutes after they finish printing. Set 0 to disable auto-cleanup.
  printedRetentionMinutes: parseInt(process.env.PRINTED_RETENTION_MINUTES || '120', 10),
  // How often the cleanup sweep runs.
  cleanupIntervalMinutes: parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '10', 10),
  folders: {
    incoming: 'incoming',
    processed: 'processed',
    printed: 'printed',
    failed: 'failed',
    temp: 'temp',
  },
  allowedExtensions: ['.jpg', '.jpeg', '.png', '.pdf', '.docx'],
  blockedExtensions: ['.exe', '.zip', '.rar', '.bat', '.cmd', '.msi', '.scr'],
};

module.exports = config;
