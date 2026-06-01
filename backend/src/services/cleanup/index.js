const config = require('../../lib/config');
const media = require('../media');
const jobsDb = require('../../db/jobs');
const activity = require('../../db/activity');

let timer = null;

function whenFinished(job) {
  // printed_at is an ISO string; fall back to updated_at for older rows.
  const stamp = job.printed_at || job.updated_at || job.created_at;
  const t = stamp ? Date.parse(stamp) : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * Purge printed jobs (and their files) that finished more than
 * `printedRetentionMinutes` ago. Returns the number of jobs removed.
 */
async function cleanupPrinted() {
  const retentionMs = config.printedRetentionMinutes * 60 * 1000;
  if (retentionMs <= 0) return 0;

  const cutoff = Date.now() - retentionMs;
  const printed = jobsDb.listJobs({ status: 'printed', limit: 100000 });
  let removed = 0;

  for (const job of printed) {
    const finished = whenFinished(job);
    if (finished == null || finished > cutoff) continue;
    try {
      await media.deleteJobFiles(job).catch(() => {});
      jobsDb.deleteJob(job.id);
      activity.log(job.id, 'auto_purged', `Removed after ${config.printedRetentionMinutes} min retention`);
      removed += 1;
    } catch (err) {
      console.error('[cleanup] failed to purge job', job.id, err.message);
    }
  }

  if (removed) console.log(`[cleanup] purged ${removed} completed job(s)`);
  return removed;
}

function start() {
  if (timer) return;
  if (config.printedRetentionMinutes <= 0) {
    console.log('[cleanup] auto-purge disabled (PRINTED_RETENTION_MINUTES=0)');
    return;
  }
  const intervalMs = Math.max(1, config.cleanupIntervalMinutes) * 60 * 1000;
  // Run once shortly after boot, then on the interval.
  cleanupPrinted().catch((e) => console.error('[cleanup] error:', e.message));
  timer = setInterval(() => {
    cleanupPrinted().catch((e) => console.error('[cleanup] error:', e.message));
  }, intervalMs);
  timer.unref?.();
  console.log(
    `[cleanup] auto-purge completed jobs older than ${config.printedRetentionMinutes} min (sweep every ${config.cleanupIntervalMinutes} min)`,
  );
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { cleanupPrinted, start, stop };
