//! SQLite layer — a Rust port of `backend/src/db/*.js`.
//!
//! The old backend used `sql.js` (an in-memory DB exported to a file on every
//! write). `rusqlite` opens the **same on-disk SQLite file directly**, so an
//! existing `ratan.db` written by sql.js is read without conversion. A single
//! `Mutex<Connection>` matches sql.js's single-threaded write model and is
//! plenty for a one-operator desktop app; locks are never held across `.await`.

pub mod activity;
pub mod jobs;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (creating if absent) the database at `path` and apply the schema.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        let db = Db { conn: Mutex::new(conn) };
        db.with(|c| init_schema(c))?;
        Ok(db)
    }

    /// Run a closure with the locked connection. The closure must not await.
    pub fn with<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Connection) -> R,
    {
        let guard = self.conn.lock().expect("db mutex poisoned");
        f(&guard)
    }
}

/// Add a column if it is missing — sql.js had no `ADD COLUMN IF NOT EXISTS`, so
/// the JS probed `PRAGMA table_info`. We do the same for forward-compatibility.
fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let existing: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .collect();
    if !existing.iter().any(|c| c == column) {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"))?;
    }
    Ok(())
}

/// Recreate the exact schema from `backend/src/db/index.js:46-101`.
fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE,
            name TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

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
        );

        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER,
            event TEXT NOT NULL,
            detail TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        "#,
    )?;

    ensure_column(conn, "print_jobs", "batch_id", "TEXT")?;
    // JSON describing how a derived job (e.g. a collage) was built, so it can be
    // re-rendered with a different preset later.
    ensure_column(conn, "print_jobs", "recipe", "TEXT")?;

    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_jobs_status   ON print_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_jobs_hash     ON print_jobs(hash);
        CREATE INDEX IF NOT EXISTS idx_jobs_created  ON print_jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_batch    ON print_jobs(batch_id);
        CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
        "#,
    )?;

    Ok(())
}
