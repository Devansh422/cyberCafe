//! `activity_log` — ports `backend/src/db/activity.js`.

use rusqlite::{params, Connection, Row};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ActivityRow {
    pub id: i64,
    pub job_id: Option<i64>,
    pub event: String,
    pub detail: Option<String>,
    pub created_at: Option<String>,
    pub filename: Option<String>,
    pub customer_name: Option<String>,
    pub status: Option<String>,
}

impl ActivityRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<ActivityRow> {
        Ok(ActivityRow {
            id: row.get("id")?,
            job_id: row.get("job_id")?,
            event: row.get("event")?,
            detail: row.get("detail")?,
            created_at: row.get("created_at")?,
            filename: row.get("filename")?,
            customer_name: row.get("customer_name")?,
            status: row.get("status")?,
        })
    }
}

/// Append an event. `detail` is truncated to 500 chars like the JS.
pub fn log(conn: &Connection, job_id: Option<i64>, event: &str, detail: Option<&str>) {
    let detail = detail.map(|d| {
        if d.chars().count() > 500 {
            d.chars().take(500).collect::<String>()
        } else {
            d.to_string()
        }
    });
    // Best-effort: a logging failure must never break the request path (the JS
    // `db.run` would throw, but activity logging is incidental).
    let _ = conn.execute(
        "INSERT INTO activity_log (job_id, event, detail) VALUES (?,?,?)",
        params![job_id, event, detail],
    );
}

pub fn list(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<ActivityRow>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.job_id, a.event, a.detail, a.created_at,
                j.filename, j.customer_name, j.status
         FROM activity_log a
         LEFT JOIN print_jobs j ON j.id = a.job_id
         ORDER BY a.created_at DESC
         LIMIT ?",
    )?;
    let rows: rusqlite::Result<Vec<ActivityRow>> =
        stmt.query_map(params![limit], ActivityRow::from_row)?.collect();
    rows
}
