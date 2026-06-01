//! Media center — ports `backend/src/services/media/index.js`.
//!
//! Saves imports into `incoming/`, dedups by SHA-256, sanitizes names, and
//! groups files a customer sends "at once" into a batch (10 s window).

use std::path::PathBuf;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::config::{self, Config};
use crate::db::{activity, jobs, Db};
use crate::error::AppResult;

/// Files within this window from the same customer join one batch.
const BATCH_WINDOW_MS: i64 = 10_000;

#[derive(Debug, Clone)]
pub struct Incoming {
    pub buffer: Vec<u8>,
    pub original_name: String,
    pub mime_type: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub source: String,
}

#[derive(Debug, Serialize)]
pub struct SaveResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<jobs::Job>,
}

fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    // Collapse runs of '_' to match the JS regex `[^...]+ -> _`.
    let mut out = String::with_capacity(cleaned.len());
    let mut prev_us = false;
    for c in cleaned.chars() {
        if c == '_' {
            if !prev_us {
                out.push(c);
            }
            prev_us = true;
        } else {
            out.push(c);
            prev_us = false;
        }
    }
    out.chars().take(80).collect()
}

fn timestamp_slug() -> String {
    chrono::Local::now().format("%Y%m%d_%H%M%S").to_string()
}

fn build_filename(customer: Option<&str>, original_name: &str) -> String {
    let safe_customer = sanitize(customer.unwrap_or("unknown"));
    let safe_name = sanitize(if original_name.is_empty() { "file" } else { original_name });
    format!("{}_{}_{}", timestamp_slug(), safe_customer, safe_name)
}

fn hash_hex(buf: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(buf);
    hex::encode(h.finalize())
}

/// Parse SQLite UTC text ("YYYY-MM-DD HH:MM:SS") to epoch millis.
fn sqlite_time_to_ms(ts: &str) -> i64 {
    chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S")
        .map(|dt| dt.and_utc().timestamp_millis())
        .unwrap_or(0)
}

/// Decide which batch a newly arrived image joins (ports `resolveBatchId`).
fn resolve_batch_id(
    conn: &rusqlite::Connection,
    job_type: &str,
    customer_key: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    if job_type != "image" {
        return Ok(None);
    }
    let key = match customer_key {
        Some(k) if !k.is_empty() => k,
        _ => return Ok(None),
    };
    let mate = match jobs::find_recent_incoming_image(conn, key)? {
        Some(m) => m,
        None => return Ok(None),
    };
    let created = mate.created_at.as_deref().map(sqlite_time_to_ms).unwrap_or(0);
    if chrono::Utc::now().timestamp_millis() - created > BATCH_WINDOW_MS {
        return Ok(None);
    }
    if let Some(b) = mate.batch_id.clone() {
        return Ok(Some(b));
    }
    // Second image of a burst: mint a batch id and back-fill the first image.
    let batch_id = uuid::Uuid::new_v4().to_string();
    jobs::update_job(
        conn,
        mate.id,
        &jobs::JobPatch { batch_id: Some(batch_id.clone()), ..Default::default() },
    )?;
    Ok(Some(batch_id))
}

pub fn absolute_path(config: &Config, folder: &str, filename: &str) -> PathBuf {
    config.absolute_path(folder, filename)
}

/// Save an imported file. Mirrors `media.saveIncoming` exactly: rejects blocked
/// types, dedups by hash, writes into `incoming/`, batches, and creates the job.
pub fn save_incoming(db: &Db, config: &Config, p: Incoming) -> AppResult<SaveResult> {
    let ext = config::ext_of(std::path::Path::new(&p.original_name));
    if !config::is_allowed_ext(&ext) {
        let who = p
            .customer_name
            .clone()
            .or_else(|| p.customer_phone.clone())
            .unwrap_or_else(|| "unknown".to_string());
        db.with(|c| activity::log(c, None, "rejected", Some(&format!("Unsupported file type .{ext} from {who}"))));
        return Ok(SaveResult { ok: false, reason: Some("unsupported_extension".into()), job: None });
    }

    let hash = hash_hex(&p.buffer);
    if let Some(dup) = db.with(|c| jobs::find_duplicate(c, &hash))? {
        db.with(|c| {
            activity::log(
                c,
                Some(dup.id),
                "duplicate",
                Some(&format!("Duplicate of #{} ({})", dup.id, dup.filename)),
            )
        });
        return Ok(SaveResult { ok: false, reason: Some("duplicate".into()), job: Some(dup) });
    }

    let customer = p.customer_name.clone().or_else(|| p.customer_phone.clone());
    let filename = build_filename(customer.as_deref(), &p.original_name);
    let target = absolute_path(config, "incoming", &filename);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, &p.buffer)?;

    let job_type = config::type_from_ext(&ext);
    let customer_key = p.customer_phone.clone().or_else(|| p.customer_name.clone());

    let job = db.with(|c| -> rusqlite::Result<jobs::Job> {
        let batch_id = resolve_batch_id(c, job_type, customer_key.as_deref())?;
        jobs::create_job(
            c,
            &jobs::NewJob {
                filename: filename.clone(),
                original_name: Some(p.original_name.clone()),
                job_type: Some(job_type.to_string()),
                mime_type: p.mime_type.clone(),
                size: Some(p.buffer.len() as i64),
                hash: Some(hash.clone()),
                customer_name: p.customer_name.clone(),
                customer_phone: p.customer_phone.clone(),
                status: Some("incoming".into()),
                source: Some(p.source.clone()),
                storage_folder: "incoming".into(),
                batch_id,
                ..Default::default()
            },
        )
    })?;

    db.with(|c| {
        activity::log(c, Some(job.id), "imported", Some(&format!("Imported {} ({} bytes)", filename, p.buffer.len())))
    });
    Ok(SaveResult { ok: true, reason: None, job: Some(job) })
}

/// Move a job's file between media folders and update its `storage_folder`.
pub fn move_job(db: &Db, config: &Config, job: &jobs::Job, to_folder: &str) -> AppResult<Option<jobs::Job>> {
    let from = absolute_path(config, &job.storage_folder, &job.filename);
    let to = absolute_path(config, to_folder, &job.filename);
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from, &to)?;
    Ok(db.with(|c| {
        jobs::update_job(c, job.id, &jobs::JobPatch { storage_folder: Some(to_folder.to_string()), ..Default::default() })
    })?)
}

/// Remove a job's original (and processed) files. Best-effort like the JS.
pub fn delete_job_files(config: &Config, job: &jobs::Job) {
    let main = absolute_path(config, &job.storage_folder, &job.filename);
    let _ = std::fs::remove_file(&main);
    if let Some(pp) = &job.processed_path {
        let _ = std::fs::remove_file(pp);
    }
}
