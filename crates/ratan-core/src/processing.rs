//! Image/PDF processing — ports `backend/src/services/processing/index.js`.
//! Renders images to A4 PDFs per preset, copies/counts existing PDFs, merges
//! processed jobs, and spools to the bundled SumatraPDF print engine.

use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::db::jobs::{self, Job};
use crate::db::activity;
use crate::error::{AppError, AppResult};
use crate::media;
use crate::print::PrintOptions;
use crate::{imaging, pdf, proc};
use crate::state::SharedState;

/// Preset keys, in the order `processing.presetList()` returned them.
pub const PRESETS: [&str; 5] = ["scan_pdf", "bw", "color", "high_contrast", "a4_resize"];

pub fn preset_list() -> Vec<&'static str> {
    PRESETS.to_vec()
}

fn strip_ext(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) => &name[..i],
        None => name,
    }
}

/// Render a job to a processed PDF using `preset`.
pub async fn process_job(state: &SharedState, job_id: i64, preset_name: &str) -> AppResult<Job> {
    let job = state
        .db
        .with(|c| jobs::get_job(c, job_id))?
        .ok_or_else(|| AppError::internal("job not found"))?;

    if imaging::preset(preset_name).is_none() {
        return Err(AppError::internal(format!("unknown preset {preset_name}")));
    }

    let src = media::absolute_path(&state.config, &job.storage_folder, &job.filename);
    if !src.exists() {
        return Err(AppError::internal(format!("source file missing: {}", src.display())));
    }

    let dest_name = format!("{}.{}.pdf", strip_ext(&job.filename), preset_name);
    let dest_dir = state.config.folder_path("processed");
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(&dest_name);

    match render_to_dest(&job, preset_name, &src, &dest).await {
        Ok(pages) => {
            let updated = state.db.with(|c| {
                let j = jobs::update_job(
                    c,
                    job_id,
                    &jobs::JobPatch {
                        status: Some("processed".into()),
                        processed_path: Some(dest.to_string_lossy().to_string()),
                        preset: Some(preset_name.to_string()),
                        pages: Some(pages),
                        ..Default::default()
                    },
                );
                activity::log(c, Some(job_id), "processed", Some(&format!("Preset {preset_name} → {dest_name}")));
                j
            })?;
            updated.ok_or_else(|| AppError::internal("processed job vanished"))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&dest);
            state.db.with(|c| {
                let _ = jobs::update_job(c, job_id, &jobs::JobPatch { status: Some("failed".into()), error: Some(e.to_string()), ..Default::default() });
                activity::log(c, Some(job_id), "process_failed", Some(&e.to_string()));
            });
            Err(AppError::internal(e.to_string()))
        }
    }
}

async fn render_to_dest(job: &Job, preset_name: &str, src: &Path, dest: &Path) -> anyhow::Result<i64> {
    match job.job_type.as_deref() {
        Some("image") => {
            let bytes = std::fs::read(src)?;
            let p = imaging::preset(preset_name).expect("preset checked by caller");
            let dest = dest.to_path_buf();
            let pdf_bytes = tokio::task::spawn_blocking(move || imaging::render_image_to_a4_pdf(&bytes, &p)).await??;
            std::fs::write(&dest, pdf_bytes)?;
            Ok(1)
        }
        Some("pdf") => {
            std::fs::copy(src, dest)?;
            let bytes = std::fs::read(dest)?;
            Ok(pdf::page_count(&bytes) as i64)
        }
        other => anyhow::bail!("unsupported job type for processing: {}", other.unwrap_or("?")),
    }
}

/// Combine several processed jobs into one printable PDF, registering the merge
/// as a new processed job (ports `mergeJobsToPdf`).
pub async fn merge_jobs_to_pdf(state: &SharedState, ids: &[i64], preset: &str) -> AppResult<Job> {
    if ids.is_empty() {
        return Err(AppError::internal("no items selected"));
    }

    let mut sources: Vec<Job> = Vec::new();
    for id in ids {
        let job = match state.db.with(|c| jobs::get_job(c, *id))? {
            Some(j) => j,
            None => continue,
        };
        let ready = job
            .processed_path
            .as_ref()
            .map(|p| Path::new(p).exists() && p.to_lowercase().ends_with(".pdf"))
            .unwrap_or(false);
        let job = if ready {
            job
        } else {
            let p = job.preset.clone();
            process_job(state, *id, p.as_deref().unwrap_or(preset)).await?
        };
        sources.push(job);
    }
    if sources.is_empty() {
        return Err(AppError::internal("no valid items to merge"));
    }

    let mut bufs = Vec::new();
    for job in &sources {
        let pp = job.processed_path.clone().ok_or_else(|| AppError::internal("missing processed file"))?;
        bufs.push(std::fs::read(&pp)?);
    }
    let merged = tokio::task::spawn_blocking(move || pdf::merge_pdfs(bufs))
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
    let page_count = pdf::page_count(&merged) as i64;

    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let dest_name = format!("batch_{ts}_{}items.pdf", sources.len());
    let dest_dir = state.config.folder_path("processed");
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(&dest_name);
    std::fs::write(&dest, &merged)?;

    let batch_id = uuid::Uuid::new_v4().to_string();
    let merged_len = merged.len() as i64;
    let count = sources.len();
    let first_name = sources[0].customer_name.clone().or_else(|| Some("Batch".into()));
    let first_phone = sources[0].customer_phone.clone();

    let job = state.db.with(|c| -> rusqlite::Result<Option<Job>> {
        let created = jobs::create_job(
            c,
            &jobs::NewJob {
                filename: dest_name.clone(),
                original_name: Some(format!("Batch of {count} files")),
                job_type: Some("pdf".into()),
                mime_type: Some("application/pdf".into()),
                size: Some(merged_len),
                customer_name: first_name,
                customer_phone: first_phone,
                status: Some("processed".into()),
                source: Some("batch".into()),
                storage_folder: "processed".into(),
                batch_id: Some(batch_id.clone()),
                ..Default::default()
            },
        )?;
        let updated = jobs::update_job(
            c,
            created.id,
            &jobs::JobPatch {
                processed_path: Some(dest.to_string_lossy().to_string()),
                preset: Some("merge".into()),
                pages: Some(page_count),
                ..Default::default()
            },
        )?;
        activity::log(c, updated.as_ref().map(|j| j.id), "batch_created", Some(&format!("Merged {count} item(s) → {dest_name}")));
        Ok(updated)
    })?;
    job.ok_or_else(|| AppError::internal("merge job vanished"))
}

// ---- Print engine (SumatraPDF) ---------------------------------------------

/// Locate the bundled SumatraPDF binary in the resource dir.
pub fn find_sumatra(config: &Config) -> Option<PathBuf> {
    let fixed = config.resource_dir.join("SumatraPDF.exe");
    if fixed.exists() {
        return Some(fixed);
    }
    let entries = std::fs::read_dir(&config.resource_dir).ok()?;
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy().to_ascii_lowercase();
        if name.starts_with("sumatrapdf") && name.ends_with(".exe") {
            return Some(e.path());
        }
    }
    None
}

pub fn print_engine_available(config: &Config) -> bool {
    find_sumatra(config).is_some()
}

/// Spool a processed PDF to the printer via SumatraPDF, replicating the flags
/// `pdf-to-printer` used (printer/copies/orientation/paperSize/monochrome).
pub async fn spool_to_printer(config: &Config, job: &Job, options: &PrintOptions) -> anyhow::Result<()> {
    let sumatra = find_sumatra(config).ok_or_else(|| anyhow::anyhow!("SumatraPDF engine missing"))?;
    let pdf = job.processed_path.clone().ok_or_else(|| anyhow::anyhow!("no processed pdf"))?;

    let mut settings: Vec<String> = Vec::new();
    if let Some(c) = options.copies {
        if c > 1 {
            settings.push(format!("{c}x"));
        }
    }
    if let Some(o) = &options.orientation {
        settings.push(o.clone());
    }
    if let Some(ps) = &options.paper_size {
        settings.push(format!("paper={ps}"));
    }
    if options.grayscale {
        settings.push("monochrome".into());
    }

    let mut args: Vec<String> = Vec::new();
    match &options.printer {
        Some(p) => {
            args.push("-print-to".into());
            args.push(p.clone());
        }
        None => args.push("-print-to-default".into()),
    }
    if !settings.is_empty() {
        args.push("-print-settings".into());
        args.push(settings.join(","));
    }
    args.push("-silent".into());
    args.push(pdf);

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = proc::run_hidden(sumatra.to_str().unwrap_or_default(), &arg_refs).await?;
    if !out.status.success() {
        anyhow::bail!("SumatraPDF exited with {:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr));
    }
    Ok(())
}
