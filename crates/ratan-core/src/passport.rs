//! Passport-photo pipeline — ports `backend/src/services/passport/index.js`.
//!
//! input → MODNet matte (bg removal) → composite over a solid colour →
//! UltraFace detection → face-centred 3:4 crop → 3×3 tile on a 4×6 sheet → PDF.
//! Both models run via `ort` (ONNX Runtime); each degrades gracefully if its
//! model is absent (matting skipped / centred-crop fallback).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use image::{imageops, GrayImage, RgbImage};
use ort::session::Session;
use serde::Serialize;

use crate::config::Config;
use crate::db::{activity, jobs};
use crate::error::{AppError, AppResult};
use crate::media;
use crate::state::SharedState;

// ---- Geometry / tuning (mirror the JS constants) ---------------------------
const REF_SIZE: u32 = 512;
const COMPOSITE_MAX: u32 = 1500;
const FACE_W: u32 = 320;
const FACE_H: u32 = 240;
const FACE_SCORE_MIN: f32 = 0.6;
const SUBJECT_MIN: f32 = 0.12;
const OUT_W: u32 = 900;
const OUT_H: u32 = 1200;
const HEAD_FROM_FACE: f32 = 1.5;
const HEAD_RATIO: f32 = 0.62;
const EYE_FROM_TOP: f32 = 0.40;
const EYE_IN_FACE: f32 = 0.40;
const MATTE_GAIN: f32 = 1.35;
const MATTE_PIVOT: f32 = 0.5;

// Sheet: 4×6in @300dpi, 3×3, portrait 3:4 photos.
const DPI: f32 = 300.0;
const SHEET_W_IN: f32 = 4.0;
const SHEET_H_IN: f32 = 6.0;
const COLS: u32 = 3;
const ROWS: u32 = 3;
const MARGIN_IN: f32 = 0.12;
const GAP_IN: f32 = 0.08;
const PHOTO_ASPECT: f32 = 3.0 / 4.0; // w/h

pub const BG_PRESETS: [(&str, &str); 4] = [
    ("light-blue", "#c9ddee"),
    ("white", "#ffffff"),
    ("light-grey", "#e9ecef"),
    ("red", "#d23b3b"),
];

fn hex_to_rgb(hex: &str) -> (u8, u8, u8) {
    let h = hex.trim().trim_start_matches('#');
    if h.len() == 6 {
        if let Ok(n) = u32::from_str_radix(h, 16) {
            return (((n >> 16) & 255) as u8, ((n >> 8) & 255) as u8, (n & 255) as u8);
        }
    }
    (201, 221, 238) // light-blue fallback
}

fn resolve_bg(bg: &Option<String>) -> (u8, u8, u8) {
    match bg {
        None => hex_to_rgb("#c9ddee"),
        Some(b) => BG_PRESETS
            .iter()
            .find(|(k, _)| k == b)
            .map(|(_, v)| hex_to_rgb(v))
            .unwrap_or_else(|| hex_to_rgb(b)),
    }
}

// ---- Session cache ----------------------------------------------------------
/// `ort` sessions need `&mut self` to run, so cache them behind a Mutex; a
/// single operator means serialized inference is fine.
type SharedSession = Arc<Mutex<Session>>;

enum Slot {
    Untried,
    Ready(SharedSession),
    Failed,
}

pub struct Passport {
    modnet: Mutex<Slot>,
    face: Mutex<Slot>,
}

impl Passport {
    pub fn new() -> Self {
        Passport { modnet: Mutex::new(Slot::Untried), face: Mutex::new(Slot::Untried) }
    }

    fn get(slot: &Mutex<Slot>, path: &Option<PathBuf>) -> Option<SharedSession> {
        let mut g = slot.lock().unwrap();
        match &*g {
            Slot::Ready(s) => return Some(s.clone()),
            Slot::Failed => return None,
            Slot::Untried => {}
        }
        let p = match path {
            Some(p) => p.clone(),
            None => {
                *g = Slot::Failed;
                return None;
            }
        };
        match Session::builder().and_then(|mut b| b.commit_from_file(&p)) {
            Ok(s) => {
                let a = Arc::new(Mutex::new(s));
                *g = Slot::Ready(a.clone());
                Some(a)
            }
            Err(e) => {
                tracing::error!("[passport] failed to load model {:?}: {e}", p);
                *g = Slot::Failed;
                None
            }
        }
    }

    fn modnet(&self, config: &Config) -> Option<SharedSession> {
        Self::get(&self.modnet, &config.modnet_model)
    }
    fn face(&self, config: &Config) -> Option<SharedSession> {
        Self::get(&self.face, &config.face_model)
    }
}

impl Default for Passport {
    fn default() -> Self {
        Self::new()
    }
}

// ---- ONNX helper ------------------------------------------------------------
struct OutTensor {
    dims: Vec<i64>,
    data: Vec<f32>,
}

fn run_session(session: &Mutex<Session>, shape: Vec<i64>, data: Vec<f32>) -> anyhow::Result<Vec<OutTensor>> {
    let mut s = session.lock().unwrap();
    let input_name = s.inputs()[0].name().to_string();
    let output_names: Vec<String> = s.outputs().iter().map(|o| o.name().to_string()).collect();
    let tensor = ort::value::Tensor::from_array((shape, data))?;
    let outputs = s.run(ort::inputs![input_name.as_str() => tensor])?;
    let mut result = Vec::new();
    for name in &output_names {
        let value = &outputs[name.as_str()];
        let (sh, dat) = value.try_extract_tensor::<f32>()?;
        result.push(OutTensor { dims: sh.iter().map(|d| *d as i64).collect(), data: dat.to_vec() });
    }
    Ok(result)
}

// ---- Status -----------------------------------------------------------------
#[derive(Debug, Serialize)]
pub struct PassportStatus {
    #[serde(rename = "ortLoaded")]
    pub ort_loaded: bool,
    #[serde(rename = "modelFound")]
    pub model_found: bool,
    #[serde(rename = "modelPath")]
    pub model_path: Option<String>,
    pub ready: bool,
    #[serde(rename = "faceModelFound")]
    pub face_model_found: bool,
    #[serde(rename = "faceReady")]
    pub face_ready: bool,
    #[serde(rename = "bgPresets")]
    pub bg_presets: Vec<String>,
}

pub fn status(config: &Config) -> PassportStatus {
    let model_found = config.modnet_model.is_some();
    let face_model_found = config.face_model.is_some();
    PassportStatus {
        ort_loaded: true, // ORT is statically linked now
        model_found,
        model_path: config.modnet_model.as_ref().map(|p| p.display().to_string()),
        ready: model_found,
        face_model_found,
        face_ready: face_model_found,
        bg_presets: BG_PRESETS.iter().map(|(k, _)| k.to_string()).collect(),
    }
}

pub fn prepared_dir(config: &Config) -> PathBuf {
    config.media_root.join("temp").join("passport")
}
pub fn prepared_path(config: &Config, id: &str) -> PathBuf {
    prepared_dir(config).join(format!("{id}.png"))
}

// ---- MODNet preprocessing dims ----------------------------------------------
fn model_dims(im_h: u32, im_w: u32) -> (u32, u32) {
    let (mut rh, mut rw);
    let max = im_h.max(im_w);
    let min = im_h.min(im_w);
    if max < REF_SIZE || min > REF_SIZE {
        if im_w >= im_h {
            rh = REF_SIZE;
            rw = ((im_w as f32 / im_h as f32) * REF_SIZE as f32).round() as u32;
        } else {
            rw = REF_SIZE;
            rh = ((im_h as f32 / im_w as f32) * REF_SIZE as f32).round() as u32;
        }
    } else {
        rh = im_h;
        rw = im_w;
    }
    rw -= rw % 32;
    rh -= rh % 32;
    (rw.max(32), rh.max(32))
}

struct Matte {
    composited: RgbImage,
    fg: RgbImage,
    matted: bool,
    subject_found: Option<bool>,
}

/// MODNet matte + composite over `bg`. Returns the composited image and the
/// original foreground (for face detection).
fn matte_composite(modnet: Option<&Mutex<Session>>, fg: RgbImage, bg: (u8, u8, u8)) -> anyhow::Result<Matte> {
    let cw = fg.width();
    let ch = fg.height();

    let session = match modnet {
        Some(s) => s,
        None => return Ok(Matte { composited: fg.clone(), fg, matted: false, subject_found: None }),
    };

    let (rw, rh) = model_dims(ch, cw);
    let model_img = imageops::resize(&fg, rw, rh, imageops::FilterType::Triangle);

    // NCHW, normalised to [-1, 1].
    let plane = (rh * rw) as usize;
    let mut chw = vec![0f32; 3 * plane];
    for (i, px) in model_img.pixels().enumerate() {
        chw[i] = (px.0[0] as f32 - 127.5) / 127.5;
        chw[plane + i] = (px.0[1] as f32 - 127.5) / 127.5;
        chw[2 * plane + i] = (px.0[2] as f32 - 127.5) / 127.5;
    }

    let outputs = run_session(session, vec![1, 3, rh as i64, rw as i64], chw)?;
    let matte = &outputs[0].data; // rh*rw, 0..1

    // Coverage gate: skip "removal" when there is no real subject.
    let mut msum = 0f32;
    for &v in matte.iter() {
        msum += v.clamp(0.0, 1.0);
    }
    let coverage = msum / matte.len() as f32;
    if coverage < SUBJECT_MIN {
        return Ok(Matte { composited: fg.clone(), fg, matted: false, subject_found: Some(false) });
    }

    // Shape matte (contrast around mid), to 8-bit gray at model resolution.
    let mut matte8 = GrayImage::new(rw, rh);
    for (i, px) in matte8.pixels_mut().enumerate() {
        let v = ((matte[i] - MATTE_PIVOT) * MATTE_GAIN + MATTE_PIVOT).clamp(0.0, 1.0);
        px.0 = [(v * 255.0).round() as u8];
    }
    // Upscale to working res + feather.
    let matte_full = imageops::blur(&imageops::resize(&matte8, cw, ch, imageops::FilterType::Triangle), 0.5);

    let mut out = RgbImage::new(cw, ch);
    for (i, px) in out.pixels_mut().enumerate() {
        let a = matte_full.get_pixel((i as u32) % cw, (i as u32) / cw).0[0] as f32 / 255.0;
        let ia = 1.0 - a;
        let s = fg.get_pixel((i as u32) % cw, (i as u32) / cw).0;
        px.0 = [
            (s[0] as f32 * a + bg.0 as f32 * ia).round() as u8,
            (s[1] as f32 * a + bg.1 as f32 * ia).round() as u8,
            (s[2] as f32 * a + bg.2 as f32 * ia).round() as u8,
        ];
    }

    Ok(Matte { composited: out, fg, matted: true, subject_found: Some(true) })
}

#[derive(Clone, Copy)]
struct FaceBox {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
}

/// Detect the dominant face (largest confident box) in the foreground.
fn detect_face(face: Option<&Mutex<Session>>, fg: &RgbImage) -> Option<FaceBox> {
    let session = face?;
    let cw = fg.width() as f32;
    let ch = fg.height() as f32;
    let resized = imageops::resize(fg, FACE_W, FACE_H, imageops::FilterType::Triangle);

    let plane = (FACE_W * FACE_H) as usize;
    let mut data = vec![0f32; 3 * plane];
    for (i, px) in resized.pixels().enumerate() {
        data[i] = (px.0[0] as f32 - 127.0) / 128.0;
        data[plane + i] = (px.0[1] as f32 - 127.0) / 128.0;
        data[2 * plane + i] = (px.0[2] as f32 - 127.0) / 128.0;
    }

    let outputs = run_session(session, vec![1, 3, FACE_H as i64, FACE_W as i64], data).ok()?;
    let mut scores: Option<&OutTensor> = None;
    let mut boxes: Option<&OutTensor> = None;
    for o in &outputs {
        match o.dims.last() {
            Some(2) => scores = Some(o),
            Some(4) => boxes = Some(o),
            _ => {}
        }
    }
    let (scores, boxes) = (scores?, boxes?);
    let n = boxes.data.len() / 4;

    let mut best: Option<(FaceBox, f32, f32)> = None; // (box, score, area)
    for i in 0..n {
        let sc = scores.data.get(i * 2 + 1).copied().unwrap_or(0.0);
        if sc < FACE_SCORE_MIN {
            continue;
        }
        let x1 = (boxes.data[i * 4] * cw).clamp(0.0, cw);
        let y1 = (boxes.data[i * 4 + 1] * ch).clamp(0.0, ch);
        let x2 = (boxes.data[i * 4 + 2] * cw).clamp(0.0, cw);
        let y2 = (boxes.data[i * 4 + 3] * ch).clamp(0.0, ch);
        let (w, h) = (x2 - x1, y2 - y1);
        if w < 8.0 || h < 8.0 {
            continue;
        }
        let area = w * h;
        let better = match best {
            None => true,
            Some((_, bs, ba)) => area > ba || (area == ba && sc > bs),
        };
        if better {
            best = Some((FaceBox { x1, y1, x2, y2 }, sc, area));
        }
    }
    best.map(|(b, _, _)| b)
}

#[derive(Clone, Copy)]
struct Rect {
    left: u32,
    top: u32,
    width: u32,
    height: u32,
}

fn clamp_rect(left: f32, top: f32, width: f32, height: f32, w: u32, h: u32) -> Rect {
    let width = width.min(w as f32);
    let height = height.min(h as f32);
    let left = left.max(0.0).min(w as f32 - width);
    let top = top.max(0.0).min(h as f32 - height);
    Rect { left: left.round() as u32, top: top.round() as u32, width: width.floor() as u32, height: height.floor() as u32 }
}

fn passport_crop(w: u32, h: u32, b: FaceBox) -> Rect {
    let fh = b.y2 - b.y1;
    let cx = (b.x1 + b.x2) / 2.0;
    let head_h = fh * HEAD_FROM_FACE;
    let mut crop_h = head_h / HEAD_RATIO;
    let mut crop_w = crop_h * PHOTO_ASPECT;
    let scale = 1.0_f32.min(w as f32 / crop_w).min(h as f32 / crop_h);
    crop_h *= scale;
    crop_w *= scale;
    let eye_y = b.y1 + EYE_IN_FACE * fh;
    let left = cx - crop_w / 2.0;
    let top = eye_y - EYE_FROM_TOP * crop_h;
    clamp_rect(left, top, crop_w, crop_h, w, h)
}

fn fallback_crop(w: u32, h: u32) -> Rect {
    let mut crop_w = w as f32;
    let mut crop_h = crop_w / PHOTO_ASPECT;
    if crop_h > h as f32 {
        crop_h = h as f32;
        crop_w = crop_h * PHOTO_ASPECT;
    }
    let left = (w as f32 - crop_w) / 2.0;
    let top = (h as f32 * 0.04).min(h as f32 - crop_h);
    clamp_rect(left, top, crop_w, crop_h, w, h)
}

/// Resize-to-cover then centre-crop to exactly `ow`×`oh` (sharp fit:cover).
fn cover_resize(img: &RgbImage, ow: u32, oh: u32) -> RgbImage {
    let (w, h) = (img.width() as f32, img.height() as f32);
    let scale = (ow as f32 / w).max(oh as f32 / h);
    let nw = (w * scale).round().max(ow as f32) as u32;
    let nh = (h * scale).round().max(oh as f32) as u32;
    let resized = imageops::resize(img, nw, nh, imageops::FilterType::Lanczos3);
    let x = (nw - ow) / 2;
    let y = (nh - oh) / 2;
    imageops::crop_imm(&resized, x, y, ow, oh).to_image()
}

// ---- Public pipeline --------------------------------------------------------
#[derive(Debug, Serialize)]
pub struct PrepareResult {
    pub id: String,
    pub matted: bool,
    #[serde(rename = "subjectFound")]
    pub subject_found: Option<bool>,
    #[serde(rename = "faceDetected")]
    pub face_detected: bool,
    pub bg: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "jobId")]
    pub job_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer: Option<String>,
}

pub async fn prepare(state: &SharedState, buffer: Vec<u8>, bg: Option<String>) -> AppResult<PrepareResult> {
    let bg_rgb = resolve_bg(&bg);
    let modnet = state.passport.modnet(&state.config);
    let face_sess = state.passport.face(&state.config);

    // Decode + EXIF orient + contain-fit into COMPOSITE_MAX.
    let img = crate::imaging::load_oriented(&buffer).map_err(|e| AppError::internal(e.to_string()))?;
    let (w, h) = (img.width(), img.height());
    let scale = (COMPOSITE_MAX as f32 / w as f32).min(COMPOSITE_MAX as f32 / h as f32).min(1.0);
    let fg = if scale < 1.0 {
        imageops::resize(&img.to_rgb8(), ((w as f32 * scale) as u32).max(1), ((h as f32 * scale) as u32).max(1), imageops::FilterType::Lanczos3)
    } else {
        img.to_rgb8()
    };

    let matte = matte_composite(modnet.as_deref(), fg, bg_rgb).map_err(|e| AppError::internal(e.to_string()))?;
    let face = detect_face(face_sess.as_deref(), &matte.fg);
    let cw = matte.composited.width();
    let ch = matte.composited.height();
    let rect = match face {
        Some(b) => passport_crop(cw, ch, b),
        None => fallback_crop(cw, ch),
    };

    let cropped = imageops::crop_imm(&matte.composited, rect.left, rect.top, rect.width.max(1), rect.height.max(1)).to_image();
    let out = cover_resize(&cropped, OUT_W, OUT_H);

    let id = uuid::Uuid::new_v4().to_string();
    std::fs::create_dir_all(prepared_dir(&state.config))?;
    out.save(prepared_path(&state.config, &id)).map_err(|e| AppError::internal(e.to_string()))?;

    let matted = matte.matted;
    let subject_found = matte.subject_found;
    state.db.with(|c| {
        activity::log(
            c,
            None,
            "passport_prepared",
            Some(&format!("Photo prepared (matted={matted}, subject={subject_found:?}, face={})", face.is_some())),
        )
    });
    Ok(PrepareResult {
        id,
        matted,
        subject_found,
        face_detected: face.is_some(),
        bg: bg.unwrap_or_else(|| "light-blue".into()),
        job_id: None,
        label: None,
        customer: None,
    })
}

pub async fn prepare_from_job(state: &SharedState, job_id: i64, bg: Option<String>) -> AppResult<PrepareResult> {
    let job = state.db.with(|c| jobs::get_job(c, job_id))?.ok_or_else(|| AppError::internal("job not found"))?;
    if job.job_type.as_deref() != Some("image") {
        return Err(AppError::internal("passport photos must be images (jpg/png)"));
    }
    let src = media::absolute_path(&state.config, &job.storage_folder, &job.filename);
    if !src.exists() {
        return Err(AppError::internal("source image file missing"));
    }
    let buffer = std::fs::read(&src)?;
    let mut res = prepare(state, buffer, bg).await?;
    res.job_id = Some(job_id);
    res.label = job.original_name.clone().or(Some(job.filename.clone()));
    res.customer = job.customer_name.clone().or(job.customer_phone.clone());
    Ok(res)
}

// ---- Sheet ------------------------------------------------------------------
struct Layout {
    sheet_w: u32,
    sheet_h: u32,
    cell_w: u32,
    cell_h: u32,
    slots: Vec<(u32, u32)>, // (left, top)
}

fn cell_layout() -> Layout {
    let sheet_w = (SHEET_W_IN * DPI).round() as u32;
    let sheet_h = (SHEET_H_IN * DPI).round() as u32;
    let margin = (MARGIN_IN * DPI).round() as u32;
    let gap = (GAP_IN * DPI).round() as u32;
    let cell_w = (sheet_w - 2 * margin - (COLS - 1) * gap) / COLS;
    let cell_h = (cell_w as f32 / PHOTO_ASPECT).round() as u32;
    let mut slots = Vec::new();
    for r in 0..ROWS {
        for c in 0..COLS {
            slots.push((margin + c * (cell_w + gap), margin + r * (cell_h + gap)));
        }
    }
    Layout { sheet_w, sheet_h, cell_w, cell_h, slots }
}

#[derive(Debug, serde::Deserialize)]
pub struct SheetItem {
    pub id: String,
    #[serde(default)]
    pub copies: Option<i64>,
}

fn build_sheet(config: &Config, ordered_ids: &[String]) -> anyhow::Result<Vec<u8>> {
    let l = cell_layout();
    let max = (COLS * ROWS) as usize;
    let ids = &ordered_ids[..ordered_ids.len().min(max)];

    let mut sheet = RgbImage::from_pixel(l.sheet_w, l.sheet_h, image::Rgb([255, 255, 255]));
    let mut placed = 0usize;
    for (i, id) in ids.iter().enumerate() {
        let p = prepared_path(config, id);
        if !p.exists() {
            continue;
        }
        let photo = image::open(&p)?.to_rgb8();
        let cell = cover_resize(&photo, l.cell_w, l.cell_h);
        let (left, top) = l.slots[i];
        imageops::overlay(&mut sheet, &cell, left as i64, top as i64);
        placed += 1;
    }
    if placed == 0 {
        anyhow::bail!("prepared photos missing — re-add them");
    }

    let page_w = SHEET_W_IN * 72.0;
    let page_h = SHEET_H_IN * 72.0;
    let mut guides = Vec::new();
    for i in 0..placed {
        let (sl, st) = l.slots[i];
        let x = (sl as f32 / l.sheet_w as f32) * page_w;
        let gw = (l.cell_w as f32 / l.sheet_w as f32) * page_w;
        let gh = (l.cell_h as f32 / l.sheet_h as f32) * page_h;
        let y = page_h - (st as f32 / l.sheet_h as f32) * page_h - gh;
        guides.push(crate::pdf::Guide { x: x as f64, y: y as f64, w: gw as f64, h: gh as f64 });
    }

    crate::pdf::image_page(sheet.as_raw(), l.sheet_w, l.sheet_h, page_w as f64, page_h as f64, &guides)
}

pub async fn create_sheet(state: &SharedState, items: Vec<SheetItem>, bg: Option<String>) -> AppResult<jobs::Job> {
    let mut ordered = Vec::new();
    for it in &items {
        let copies = it.copies.unwrap_or(1).clamp(1, 9);
        for _ in 0..copies {
            ordered.push(it.id.clone());
        }
    }
    if ordered.is_empty() {
        return Err(AppError::bad("add at least one photo"));
    }

    let config = state.config.clone();
    let pdf_bytes = tokio::task::spawn_blocking(move || build_sheet(&config, &ordered))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
        .map_err(|e| AppError::internal(e.to_string()))?;

    let count = items.iter().map(|i| i.copies.unwrap_or(1).clamp(1, 9)).sum::<i64>().min((COLS * ROWS) as i64);
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let dest_name = format!("passport_{ts}_{count}up.pdf");
    let dest_dir = state.config.folder_path("processed");
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(&dest_name);
    std::fs::write(&dest, &pdf_bytes)?;

    let size = pdf_bytes.len() as i64;
    let bg_label = bg.clone().unwrap_or_else(|| "light-blue".into());
    let job = state.db.with(|c| -> rusqlite::Result<Option<jobs::Job>> {
        let created = jobs::create_job(
            c,
            &jobs::NewJob {
                filename: dest_name.clone(),
                original_name: Some(format!("Passport sheet · {count} photo{}", if count == 1 { "" } else { "s" })),
                job_type: Some("pdf".into()),
                mime_type: Some("application/pdf".into()),
                size: Some(size),
                customer_name: Some("Passport".into()),
                status: Some("processed".into()),
                source: Some("passport".into()),
                storage_folder: "processed".into(),
                ..Default::default()
            },
        )?;
        let updated = jobs::update_job(
            c,
            created.id,
            &jobs::JobPatch { processed_path: Some(dest.to_string_lossy().to_string()), preset: Some("passport".into()), pages: Some(1), ..Default::default() },
        )?;
        activity::log(c, updated.as_ref().map(|j| j.id), "passport_sheet", Some(&format!("Passport sheet {dest_name} ({count} up, bg={bg_label})")));
        Ok(updated)
    })?;
    job.ok_or_else(|| AppError::internal("passport job vanished"))
}
