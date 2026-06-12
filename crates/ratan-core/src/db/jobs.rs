//! `print_jobs` model + queries — ports `backend/src/db/jobs.js`.
//!
//! `Job` serializes to exactly the JSON the Express backend returned (raw rows),
//! so the existing frontend needs no changes. Note `type` is renamed from the
//! Rust-safe `job_type`.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: i64,
    pub filename: String,
    pub original_name: Option<String>,
    #[serde(rename = "type")]
    pub job_type: Option<String>,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub hash: Option<String>,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub status: String,
    pub source: Option<String>,
    pub storage_folder: String,
    pub processed_path: Option<String>,
    pub preset: Option<String>,
    pub pages: Option<i64>,
    pub copies: Option<i64>,
    pub printer: Option<String>,
    pub error: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub printed_at: Option<String>,
    pub batch_id: Option<String>,
    pub recipe: Option<String>,
}

impl Job {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Job> {
        Ok(Job {
            id: row.get("id")?,
            filename: row.get("filename")?,
            original_name: row.get("original_name")?,
            job_type: row.get("type")?,
            mime_type: row.get("mime_type")?,
            size: row.get("size")?,
            hash: row.get("hash")?,
            customer_id: row.get("customer_id")?,
            customer_name: row.get("customer_name")?,
            customer_phone: row.get("customer_phone")?,
            status: row.get("status")?,
            source: row.get("source")?,
            storage_folder: row.get("storage_folder")?,
            processed_path: row.get("processed_path")?,
            preset: row.get("preset")?,
            pages: row.get("pages")?,
            copies: row.get("copies")?,
            printer: row.get("printer")?,
            error: row.get("error")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            printed_at: row.get("printed_at")?,
            batch_id: row.get("batch_id")?,
            recipe: row.get("recipe")?,
        })
    }
}

/// New-job payload (mirrors the `createJob` argument object).
#[derive(Debug, Default, Clone)]
pub struct NewJob {
    pub filename: String,
    pub original_name: Option<String>,
    pub job_type: Option<String>,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub hash: Option<String>,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub status: Option<String>,
    pub source: Option<String>,
    pub storage_folder: String,
    pub batch_id: Option<String>,
    pub recipe: Option<String>,
}

/// Sparse update (mirrors the `updateJob` patch object). `None` fields are left
/// unchanged; `Some(None)` would set NULL but we model nullable sets as the
/// outer Option only, matching how the JS only ever sets concrete values.
#[derive(Debug, Default, Clone)]
pub struct JobPatch {
    pub filename: Option<String>,
    pub size: Option<i64>,
    pub status: Option<String>,
    pub processed_path: Option<String>,
    pub storage_folder: Option<String>,
    pub preset: Option<String>,
    pub pages: Option<i64>,
    pub copies: Option<i64>,
    pub printer: Option<String>,
    pub error: Option<String>,
    pub printed_at: Option<String>,
    pub batch_id: Option<String>,
    pub recipe: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Counts {
    pub incoming: i64,
    pub processed: i64,
    pub printing: i64,
    pub printed: i64,
    pub failed: i64,
}

pub fn create_job(conn: &Connection, job: &NewJob) -> rusqlite::Result<Job> {
    conn.execute(
        "INSERT INTO print_jobs
            (filename, original_name, type, mime_type, size, hash,
             customer_id, customer_name, customer_phone,
             status, source, storage_folder, batch_id, recipe)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            job.filename,
            job.original_name.clone().unwrap_or_else(|| job.filename.clone()),
            job.job_type,
            job.mime_type,
            job.size.unwrap_or(0),
            job.hash,
            job.customer_id,
            job.customer_name,
            job.customer_phone,
            job.status.clone().unwrap_or_else(|| "incoming".to_string()),
            job.source.clone().unwrap_or_else(|| "whatsapp".to_string()),
            job.storage_folder,
            job.batch_id,
            job.recipe,
        ],
    )?;
    let id = conn.last_insert_rowid();
    get_job(conn, id).map(|j| j.expect("row just inserted"))
}

pub fn get_job(conn: &Connection, id: i64) -> rusqlite::Result<Option<Job>> {
    conn.query_row("SELECT * FROM print_jobs WHERE id = ?", params![id], Job::from_row)
        .optional()
}

pub fn find_duplicate(conn: &Connection, hash: &str) -> rusqlite::Result<Option<Job>> {
    if hash.is_empty() {
        return Ok(None);
    }
    conn.query_row("SELECT * FROM print_jobs WHERE hash = ? LIMIT 1", params![hash], Job::from_row)
        .optional()
}

/// Most recent incoming image from the same customer — drives batch grouping.
pub fn find_recent_incoming_image(conn: &Connection, customer_key: &str) -> rusqlite::Result<Option<Job>> {
    if customer_key.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT * FROM print_jobs
          WHERE status = 'incoming' AND type = 'image'
            AND (customer_phone = ?1 OR customer_name = ?1)
          ORDER BY created_at DESC, id DESC
          LIMIT 1",
        params![customer_key],
        Job::from_row,
    )
    .optional()
}

pub fn list_by_batch(conn: &Connection, batch_id: &str) -> rusqlite::Result<Vec<Job>> {
    if batch_id.is_empty() {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare(
        "SELECT * FROM print_jobs WHERE batch_id = ? ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![batch_id], Job::from_row)?;
    rows.collect()
}

pub fn list_jobs(conn: &Connection, status: Option<&str>, limit: i64, offset: i64) -> rusqlite::Result<Vec<Job>> {
    match status {
        Some(s) => {
            let mut stmt = conn.prepare(
                "SELECT * FROM print_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            )?;
            let out: rusqlite::Result<Vec<Job>> =
                stmt.query_map(params![s, limit, offset], Job::from_row)?.collect();
            out
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?",
            )?;
            let out: rusqlite::Result<Vec<Job>> =
                stmt.query_map(params![limit, offset], Job::from_row)?.collect();
            out
        }
    }
}

pub fn update_job(conn: &Connection, id: i64, patch: &JobPatch) -> rusqlite::Result<Option<Job>> {
    let mut sets: Vec<&str> = Vec::new();
    let mut vals: Vec<Value> = Vec::new();

    macro_rules! set_opt {
        ($field:expr, $col:literal, $conv:expr) => {
            if let Some(v) = &$field {
                sets.push(concat!($col, " = ?"));
                vals.push($conv(v.clone()));
            }
        };
    }

    set_opt!(patch.filename, "filename", Value::from);
    set_opt!(patch.size, "size", Value::from);
    set_opt!(patch.status, "status", Value::from);
    set_opt!(patch.processed_path, "processed_path", Value::from);
    set_opt!(patch.storage_folder, "storage_folder", Value::from);
    set_opt!(patch.preset, "preset", Value::from);
    set_opt!(patch.pages, "pages", Value::from);
    set_opt!(patch.copies, "copies", Value::from);
    set_opt!(patch.printer, "printer", Value::from);
    set_opt!(patch.error, "error", Value::from);
    set_opt!(patch.printed_at, "printed_at", Value::from);
    set_opt!(patch.batch_id, "batch_id", Value::from);

    // Nothing concrete to set ⇒ behave like the JS early-return (just fetch).
    if sets.is_empty() {
        return get_job(conn, id);
    }

    // updated_at is always bumped, as a SQL literal (not a bound param).
    let mut assignments = sets.join(", ");
    assignments.push_str(", updated_at = datetime('now')");
    vals.push(Value::from(id));

    let sql = format!("UPDATE print_jobs SET {assignments} WHERE id = ?");
    conn.execute(&sql, params_from_iter(vals))?;
    get_job(conn, id)
}

pub fn delete_job(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM print_jobs WHERE id = ?", params![id])?;
    Ok(())
}

pub fn count_by_status(conn: &Connection) -> rusqlite::Result<Counts> {
    let one = |status: &str| -> rusqlite::Result<i64> {
        conn.query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE status = ?",
            params![status],
            |r| r.get(0),
        )
    };
    Ok(Counts {
        incoming: one("incoming")?,
        processed: one("processed")?,
        printing: one("printing")?,
        printed: one("printed")?,
        failed: one("failed")?,
    })
}
