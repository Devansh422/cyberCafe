const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(
  __dirname,
  '..', '..', 'data', 'ratan.db'
);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const initSqlJs = require('sql.js');

let db;
let saveScheduled = false;

function persist() {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(() => {
    saveScheduled = false;
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  });
}

function ensureColumn(table, column, definition) {
  const cols = [];
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  while (stmt.step()) cols.push(stmt.getAsObject().name);
  stmt.free();
  if (!cols.includes(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function init() {
  return initSqlJs().then((SQL) => {
    if (fs.existsSync(dbPath)) {
      db = new SQL.Database(fs.readFileSync(dbPath));
    } else {
      db = new SQL.Database();
    }

    db.run(`PRAGMA foreign_keys = ON`);

    db.run(`
      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE,
        name TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS print_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        original_name TEXT,
        type TEXT,
        mime_type TEXT,
        size INTEGER,
        hash TEXT,
        customer_id INTEGER,
        customer_name TEXT,
        customer_phone TEXT,
        status TEXT NOT NULL DEFAULT 'incoming',
        source TEXT DEFAULT 'whatsapp',
        storage_folder TEXT NOT NULL,
        processed_path TEXT,
        preset TEXT,
        pages INTEGER,
        copies INTEGER DEFAULT 1,
        printer TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        printed_at TEXT
      )
    `);

    // Lightweight migrations for columns added after the first release. sql.js
    // has no "ADD COLUMN IF NOT EXISTS", so probe the schema first.
    ensureColumn('print_jobs', 'batch_id', 'TEXT');

    db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON print_jobs(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_hash ON print_jobs(hash)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_created ON print_jobs(created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_batch ON print_jobs(batch_id)`);

    db.run(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER,
        event TEXT NOT NULL,
        detail TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at)`);

    persist();
    return db;
  });
}

function getDb() {
  if (!db) throw new Error('DB not initialized — call init() first');
  return db;
}

function run(sql, params = []) {
  const d = getDb();
  d.run(sql, params);
  persist();
}

function get(sql, params = []) {
  const d = getDb();
  const stmt = d.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

function all(sql, params = []) {
  const d = getDb();
  const results = [];
  const stmt = d.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function lastInsertRowid() {
  const row = get('SELECT last_insert_rowid() as id');
  return row ? row.id : null;
}

module.exports = { init, getDb, run, get, all, lastInsertRowid, persist };
