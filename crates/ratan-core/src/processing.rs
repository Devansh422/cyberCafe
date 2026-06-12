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
pub const PRESETS: [&str; 6] = ["scan_pdf", "bw", "color", "high_contrast", "a4_resize", "inverted"];

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

// ---- Collage (2-photo ID-print sheet) --------------------------------------

/// One photo's placement in the collage. `zoom` multiplies the contain-fit
/// scale (1.0 = whole photo visible); `pan_x`/`pan_y` shift it within its cell
/// as a fraction of half the cell (0 = centered, ±1 = shifted by half a cell);
/// `rotation` is degrees clockwise about the cell center; `flip_h`/`flip_v`
/// mirror the photo. Matches the CSS transform the editor preview applies.
pub struct CollageItem {
    pub id: i64,
    pub zoom: f32,
    pub pan_x: f32,
    pub pan_y: f32,
    pub rotation: f32,
    pub flip_h: bool,
    pub flip_v: bool,
}

/// Cell rectangles as page fractions [x, y, w, h] (top-down origin). Both
/// photos sit in the TOP HALF of the A4 page (the bottom half stays blank for
/// stamps/signatures or to fold the sheet). MUST stay in sync with
/// `COLLAGE_CELLS` in the frontend so the preview matches output.
fn collage_cells(layout: &str) -> [[f64; 4]; 2] {
    match layout {
        // Side by side in the top half — two portrait cells.
        "horizontal" => [[0.05, 0.045, 0.43, 0.435], [0.52, 0.045, 0.43, 0.435]],
        // "vertical" (default): stacked in the top half — the usual ID front/back sheet.
        _ => [[0.06, 0.045, 0.88, 0.205], [0.06, 0.275, 0.88, 0.205]],
    }
}

/// Compose the two oriented photos onto a single white A4 page per `layout`,
/// honoring each photo's zoom/pan/rotation/flip, and return the page as a JPEG
/// with light cut-guides around each cell (unless `guides` is off).
fn compose_collage(layout: &str, items: Vec<(image::DynamicImage, CollageItem)>, guides: bool) -> anyhow::Result<Vec<u8>> {
    use image::imageops::{overlay, resize, FilterType};
    use image::{GenericImageView, Rgb, RgbImage};

    let (aw, ah) = (imaging::A4_W, imaging::A4_H);
    let mut canvas = RgbImage::from_pixel(aw, ah, Rgb([255, 255, 255]));
    let cells = collage_cells(layout);

    for (i, (img, it)) in items.into_iter().enumerate() {
        let [fx, fy, fw, fh] = cells[i];
        let cw = (fw * aw as f64).round().max(1.0) as u32;
        let ch = (fh * ah as f64).round().max(1.0) as u32;
        let cx = (fx * aw as f64).round() as i64;
        let cy = (fy * ah as f64).round() as i64;

        let (iw, ih) = img.dimensions();
        let s_contain = (cw as f32 / iw as f32).min(ch as f32 / ih as f32);
        let scale = (s_contain * it.zoom).max(0.001);
        let sw = ((iw as f32 * scale).round() as u32).max(1);
        let sh = ((ih as f32 * scale).round() as u32).max(1);
        let mut scaled = resize(&img.to_rgb8(), sw, sh, FilterType::Lanczos3);

        // Mirror the CSS pipeline `translate(pan) scale(±zoom) rotate(deg)`:
        // content is rotated first, then flipped, then panned. Uniform scaling
        // commutes with rotation, so resizing first is equivalent and cheaper.
        if it.rotation.rem_euclid(360.0) != 0.0 {
            scaled = imaging::rotate_rgb(&scaled, it.rotation);
        }
        if it.flip_h {
            scaled = image::imageops::flip_horizontal(&scaled);
        }
        if it.flip_v {
            scaled = image::imageops::flip_vertical(&scaled);
        }
        let (sw, sh) = (scaled.width(), scaled.height());

        // Center the photo in its cell, then apply the pan, and overlay onto a
        // per-cell canvas so anything outside the cell is clipped.
        let mut cell = RgbImage::from_pixel(cw, ch, Rgb([255, 255, 255]));
        let dx = ((cw as f32 - sw as f32) / 2.0 + it.pan_x * (cw as f32 / 2.0)).round() as i64;
        let dy = ((ch as f32 - sh as f32) / 2.0 + it.pan_y * (ch as f32 / 2.0)).round() as i64;
        overlay(&mut cell, &scaled, dx, dy);
        overlay(&mut canvas, &cell, cx, cy);

        if !guides {
            continue;
        }

        // Draw dashed cut-guide on canvas
        let x0 = cx as i32;
        let y0 = cy as i32;
        let x1 = (cx + cw as i64) as i32 - 1;
        let y1 = (cy + ch as i64) as i32 - 1;

        let color = Rgb([200, 200, 200]);
        let dash_len = 20;
        for x in x0..=x1 {
            if (x / dash_len) % 2 == 0 {
                if x >= 0 && x < aw as i32 && y0 >= 0 && y0 < ah as i32 { canvas.put_pixel(x as u32, y0 as u32, color); }
                if x >= 0 && x < aw as i32 && y1 >= 0 && y1 < ah as i32 { canvas.put_pixel(x as u32, y1 as u32, color); }
            }
        }
        for y in y0..=y1 {
            if (y / dash_len) % 2 == 0 {
                if x0 >= 0 && x0 < aw as i32 && y >= 0 && y < ah as i32 { canvas.put_pixel(x0 as u32, y as u32, color); }
                if x1 >= 0 && x1 < aw as i32 && y >= 0 && y < ah as i32 { canvas.put_pixel(x1 as u32, y as u32, color); }
            }
        }
    }

    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(canvas).write_to(&mut buf, image::ImageFormat::Jpeg).map_err(|e| anyhow::anyhow!("jpeg encode failed: {}", e))?;
    Ok(buf.into_inner())
}

/// Build a 2-photo collage (horizontal or vertical) and register it as a new
/// processed PDF job, ready to print or save — for double-sided ID prints.
pub async fn make_collage(state: &SharedState, layout: &str, items: Vec<CollageItem>, guides: bool) -> AppResult<Job> {
    if items.len() != 2 {
        return Err(AppError::bad("a collage needs exactly 2 photos"));
    }

    let mut loaded: Vec<(image::DynamicImage, CollageItem)> = Vec::new();
    let mut first_name = None;
    let mut first_phone = None;
    for (idx, it) in items.into_iter().enumerate() {
        let job = state
            .db
            .with(|c| jobs::get_job(c, it.id))?
            .ok_or_else(|| AppError::bad(format!("photo #{} not found", it.id)))?;
        if job.job_type.as_deref() != Some("image") {
            return Err(AppError::bad("collage items must be photos (images)"));
        }
        let src = media::absolute_path(&state.config, &job.storage_folder, &job.filename);
        if !src.exists() {
            return Err(AppError::internal(format!("source missing: {}", src.display())));
        }
        let bytes = std::fs::read(&src)?;
        let img = imaging::load_oriented(&bytes).map_err(|e| AppError::internal(e.to_string()))?;
        if idx == 0 {
            first_name = job.customer_name.clone();
            first_phone = job.customer_phone.clone();
        }
        loaded.push((img, it));
    }

    let layout_owned = if layout == "horizontal" { "horizontal".to_string() } else { "vertical".to_string() };
    let layout_for_blocking = layout_owned.clone();
    let jpeg_bytes = tokio::task::spawn_blocking(move || compose_collage(&layout_for_blocking, loaded, guides))
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;

    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let dest_name = format!("collage_{ts}_{layout_owned}.jpg");
    // The collage is registered as a normal *incoming image* — NOT a finished PDF.
    // The operator then chooses a preset (e.g. a scan look) and processes/prints it
    // through the usual flow, so presets apply to the collage like any other photo.
    // (Previously this force-rendered a high_contrast PDF here, which locked the
    // collage into one look with no chance to pick a preset.)
    let dest_dir = state.config.folder_path("incoming");
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(&dest_name);
    std::fs::write(&dest, &jpeg_bytes)?;

    let size = jpeg_bytes.len() as i64;
    let batch_id = uuid::Uuid::new_v4().to_string();
    let job = state.db.with(|c| -> rusqlite::Result<Job> {
        let created = jobs::create_job(
            c,
            &jobs::NewJob {
                filename: dest_name.clone(),
                original_name: Some(format!("Collage ({layout_owned})")),
                job_type: Some("image".into()),
                mime_type: Some("image/jpeg".into()),
                size: Some(size),
                customer_name: first_name,
                customer_phone: first_phone,
                status: Some("incoming".into()),
                source: Some("collage".into()),
                storage_folder: "incoming".into(),
                batch_id: Some(batch_id.clone()),
                ..Default::default()
            },
        )?;
        activity::log(c, Some(created.id), "collage_created", Some(&format!("2-photo {layout_owned} collage → {dest_name} (ready to process)")));
        Ok(created)
    })?;

    Ok(job)
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
