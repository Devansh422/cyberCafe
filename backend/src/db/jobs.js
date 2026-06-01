const db = require('./index');

function createJob(job) {
  db.run(
    `INSERT INTO print_jobs
      (filename, original_name, type, mime_type, size, hash,
       customer_id, customer_name, customer_phone,
       status, source, storage_folder, batch_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      job.filename,
      job.original_name || job.filename,
      job.type || null,
      job.mime_type || null,
      job.size || 0,
      job.hash || null,
      job.customer_id || null,
      job.customer_name || null,
      job.customer_phone || null,
      job.status || 'incoming',
      job.source || 'whatsapp',
      job.storage_folder,
      job.batch_id || null,
    ]
  );
  const id = db.lastInsertRowid();
  return getJob(id);
}

// The most recent incoming image from the same customer, used to decide whether
// a freshly arrived image should join an existing batch (sent "at once").
function findRecentIncomingImage(customerKey) {
  if (!customerKey) return null;
  return db.get(
    `SELECT * FROM print_jobs
      WHERE status = 'incoming' AND type = 'image'
        AND (customer_phone = ? OR customer_name = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [customerKey, customerKey]
  ) || null;
}

function listByBatch(batchId) {
  if (!batchId) return [];
  return db.all(
    'SELECT * FROM print_jobs WHERE batch_id = ? ORDER BY created_at ASC, id ASC',
    [batchId]
  );
}

function findDuplicate(hash) {
  if (!hash) return null;
  return db.get('SELECT * FROM print_jobs WHERE hash = ? LIMIT 1', [hash]) || null;
}

function listJobs({ status, limit = 100, offset = 0 } = {}) {
  if (status) {
    return db.all(
      'SELECT * FROM print_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [status, limit, offset]
    );
  }
  return db.all(
    'SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );
}

function getJob(id) {
  return db.get('SELECT * FROM print_jobs WHERE id = ?', [id]) || null;
}

function updateJob(id, patch) {
  const fields = [];
  const vals = [];

  if (patch.status !== undefined) { fields.push('status = ?'); vals.push(patch.status); }
  if (patch.processed_path !== undefined) { fields.push('processed_path = ?'); vals.push(patch.processed_path); }
  if (patch.storage_folder !== undefined) { fields.push('storage_folder = ?'); vals.push(patch.storage_folder); }
  if (patch.preset !== undefined) { fields.push('preset = ?'); vals.push(patch.preset); }
  if (patch.pages !== undefined) { fields.push('pages = ?'); vals.push(patch.pages); }
  if (patch.copies !== undefined) { fields.push('copies = ?'); vals.push(patch.copies); }
  if (patch.printer !== undefined) { fields.push('printer = ?'); vals.push(patch.printer); }
  if (patch.error !== undefined) { fields.push('error = ?'); vals.push(patch.error); }
  if (patch.printed_at !== undefined) { fields.push('printed_at = ?'); vals.push(patch.printed_at); }
  if (patch.batch_id !== undefined) { fields.push('batch_id = ?'); vals.push(patch.batch_id); }

  fields.push("updated_at = datetime('now')");

  if (fields.length === 1) return getJob(id);
  vals.push(id);
  db.run(`UPDATE print_jobs SET ${fields.join(', ')} WHERE id = ?`, vals);
  return getJob(id);
}

function deleteJob(id) {
  db.run('DELETE FROM print_jobs WHERE id = ?', [id]);
}

function countByStatus() {
  const statuses = ['incoming', 'processed', 'printing', 'printed', 'failed'];
  const out = {};
  for (const s of statuses) {
    const row = db.get('SELECT COUNT(*) as c FROM print_jobs WHERE status = ?', [s]);
    out[s] = row ? Number(row.c) : 0;
  }
  return out;
}

module.exports = {
  createJob,
  findDuplicate,
  findRecentIncomingImage,
  listByBatch,
  listJobs,
  getJob,
  updateJob,
  deleteJob,
  countByStatus,
};
