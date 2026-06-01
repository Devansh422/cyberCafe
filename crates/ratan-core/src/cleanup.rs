//! Retention sweep — ports `backend/src/services/cleanup/index.js`.
//! Auto-purges printed jobs (and their files) older than the retention window.

use std::time::Duration;

use crate::db::{activity, jobs};
use crate::media;
use crate::state::SharedState;

/// When a job "finished": printed_at, else updated_at, else created_at, as ms.
fn when_finished(job: &jobs::Job) -> Option<i64> {
    let stamp = job
        .printed_at
        .as_deref()
        .or(job.updated_at.as_deref())
        .or(job.created_at.as_deref())?;
    parse_ms(stamp)
}

fn parse_ms(stamp: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(stamp) {
        return Some(dt.timestamp_millis());
    }
    chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M:%S")
        .map(|dt| dt.and_utc().timestamp_millis())
        .ok()
}

/// Purge printed jobs older than the configured retention. Returns count removed.
pub fn cleanup_printed(state: &SharedState) -> usize {
    let retention_ms = state.config.printed_retention_minutes * 60_000;
    if retention_ms <= 0 {
        return 0;
    }
    let cutoff = chrono::Utc::now().timestamp_millis() - retention_ms;
    let printed = state.db.with(|c| jobs::list_jobs(c, Some("printed"), 100_000, 0)).unwrap_or_default();
    let mut removed = 0;
    for job in printed {
        match when_finished(&job) {
            Some(f) if f <= cutoff => {}
            _ => continue,
        }
        media::delete_job_files(&state.config, &job);
        state.db.with(|c| {
            let _ = jobs::delete_job(c, job.id);
            activity::log(
                c,
                Some(job.id),
                "auto_purged",
                Some(&format!("Removed after {} min retention", state.config.printed_retention_minutes)),
            );
        });
        removed += 1;
    }
    if removed > 0 {
        tracing::info!("[cleanup] purged {removed} completed job(s)");
    }
    removed
}

/// Run an initial sweep then repeat on the configured interval.
pub fn spawn(state: SharedState) {
    if state.config.printed_retention_minutes <= 0 {
        tracing::info!("[cleanup] auto-purge disabled (PRINTED_RETENTION_MINUTES=0)");
        return;
    }
    let interval_minutes = state.config.cleanup_interval_minutes.max(1) as u64;
    tokio::spawn(async move {
        cleanup_printed(&state);
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_minutes * 60));
        ticker.tick().await; // first tick is immediate; consume it
        loop {
            ticker.tick().await;
            cleanup_printed(&state);
        }
    });
}
