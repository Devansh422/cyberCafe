const db = require('./index');

function log(jobId, event, detail = null) {
  db.run(
    'INSERT INTO activity_log (job_id, event, detail) VALUES (?,?,?)',
    [jobId ?? null, event, detail ? String(detail).slice(0, 500) : null]
  );
}

function list(limit = 25) {
  return db.all(
    `SELECT a.id, a.job_id, a.event, a.detail, a.created_at,
            j.filename, j.customer_name, j.status
     FROM activity_log a
     LEFT JOIN print_jobs j ON j.id = a.job_id
     ORDER BY a.created_at DESC
     LIMIT ?`,
    [limit]
  );
}

module.exports = { log, list };
