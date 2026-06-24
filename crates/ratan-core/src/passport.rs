//! Passport-photo pipeline — ports `backend/src/services/passport/index.js`.
//!
//! Stages: EXIF orient, optional auto-straighten (landmark roll), MODNet matte,
//! connected-component subject isolation (drops stray background blobs), alpha
//! shaping plus feather, auto white-balance/exposure/contrast on the subject,
//! composite over a solid colour, UltraFace-centred 3:4 crop, print sharpen, and
//! finally a 3×3 tile onto a 4×6 sheet PDF. Every model (MODNet matte, UltraFace
//! boxes, landmark roll) is optional and degrades gracefully when its `.onnx` is
//! absent.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use image::{imageops, GrayImage, Rgb, RgbImage};
use ort::session::Session;
use serde::Serialize;

use crate::config::Config;
use crate::db::{activity, jobs};
use crate::error::{AppError, AppResult};
use crate::imaging::clamp_u8;
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

// ---- Matte cleanup tuning ---------------------------------------------------
/// Binarisation threshold (on the raw 0..1 matte) used to find subject blobs.
const SUBJECT_THRESH: f32 = 0.5;
/// Grow the kept subject mask by this many model-res pixels so the soft hair
/// edge isn't clipped before the alpha is shaped.
const KEEP_DILATE_ITERS: u32 = 5;
/// Alpha-shaping band: below `ALPHA_LO` → fully transparent (kills background
/// haze), above `ALPHA_HI` → fully opaque, smoothstep in between (keeps a soft
/// hair edge).
const ALPHA_LO: f32 = 0.08;
const ALPHA_HI: f32 = 0.92;
/// Edge feather applied to the upscaled matte (px).
const FEATHER_SIGMA: f32 = 1.0;

// ---- Auto-enhancement tuning ------------------------------------------------
/// Target face luminance (0..255) the auto-exposure aims for — bright, not blown.
const EXPO_TARGET: f32 = 188.0;
const EXPO_GAIN_MIN: f32 = 0.80;
const EXPO_GAIN_MAX: f32 = 1.55;
/// Fraction of the gray-world white-balance correction to actually apply, and
/// the per-channel clamp — gentle, so skin never turns grey.
const WB_DAMP: f32 = 0.5;
const WB_GAIN_MIN: f32 = 0.90;
const WB_GAIN_MAX: f32 = 1.12;
/// Mild contrast lift around mid-grey.
const CONTRAST: f32 = 1.06;
/// Final print-sharpen (unsharp mask) on the finished photo.
const SHARPEN_SIGMA: f32 = 1.0;
const SHARPEN_AMT: i32 = 1;

// ---- Rotation tuning --------------------------------------------------------
/// Max degrees the auto-straighten will rotate (avoids wild corrections on a
/// mis-detected face), and the manual nudge clamp.
const MAX_STRAIGHTEN_DEG: f32 = 15.0;
const MANUAL_ROTATE_MAX: f32 = 45.0;
/// WFLW-98 landmark indices for the two eye pupils (used to measure head roll).
const LM_LEN_98: usize = 196; // 98 points × 2 — gates on this exact model output
const LM_LEFT_PUPIL: usize = 96;
const LM_RIGHT_PUPIL: usize = 97;

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
    landmark: Mutex<Slot>,
}

impl Passport {
    pub fn new() -> Self {
        Passport {
            modnet: Mutex::new(Slot::Untried),
            face: Mutex::new(Slot::Untried),
            landmark: Mutex::new(Slot::Untried),
        }
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
        let built = Session::builder().and_then(|b| {
            // Full graph optimisation + a small intra-op thread pool: the heavy
            // win is MODNet, which is meaningfully faster fused. Threads are
            // capped so a busy café PC stays responsive.
            let b = b.with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?;
            let mut b = b.with_intra_threads(2)?;
            b.commit_from_file(&p)
        });
        match built {
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
    fn landmark(&self, config: &Config) -> Option<SharedSession> {
        Self::get(&self.landmark, &config.landmark_model)
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
        result.push(OutTensor { dims: sh.to_vec(), data: dat.to_vec() });
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
    #[serde(rename = "landmarkModelFound")]
    pub landmark_model_found: bool,
    #[serde(rename = "bgPresets")]
    pub bg_presets: Vec<String>,
}

pub fn status(config: &Config) -> PassportStatus {
    // Report a model as "found" only when its file is actually present — with the
    // externalized-components flow the path is configured before the download
    // lands, so a mere `Some(path)` no longer implies the model is on disk.
    let exists = |p: &Option<PathBuf>| p.as_ref().map(|p| p.exists()).unwrap_or(false);
    let model_found = exists(&config.modnet_model);
    let face_model_found = exists(&config.face_model);
    PassportStatus {
        ort_loaded: true, // ORT is statically linked now
        model_found,
        model_path: config.modnet_model.as_ref().map(|p| p.display().to_string()),
        ready: model_found,
        face_model_found,
        face_ready: face_model_found,
        landmark_model_found: exists(&config.landmark_model),
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

// ---- Connected-component subject isolation ----------------------------------
/// Label 4-connected blobs in a binary mask; return (labels, per-label size).
/// Label 0 means "background" (not a blob).
fn label_components(mask: &[bool], w: usize, h: usize) -> (Vec<u32>, Vec<usize>) {
    let mut labels = vec![0u32; w * h];
    let mut sizes = vec![0usize]; // sizes[0] unused (background)
    let mut next = 1u32;
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..w * h {
        if !mask[start] || labels[start] != 0 {
            continue;
        }
        let id = next;
        next += 1;
        let mut count = 0usize;
        labels[start] = id;
        stack.push(start);
        while let Some(p) = stack.pop() {
            count += 1;
            let (x, y) = (p % w, p / w);
            // 4-neighbours
            if x > 0 {
                let n = p - 1;
                if mask[n] && labels[n] == 0 {
                    labels[n] = id;
                    stack.push(n);
                }
            }
            if x + 1 < w {
                let n = p + 1;
                if mask[n] && labels[n] == 0 {
                    labels[n] = id;
                    stack.push(n);
                }
            }
            if y > 0 {
                let n = p - w;
                if mask[n] && labels[n] == 0 {
                    labels[n] = id;
                    stack.push(n);
                }
            }
            if y + 1 < h {
                let n = p + w;
                if mask[n] && labels[n] == 0 {
                    labels[n] = id;
                    stack.push(n);
                }
            }
        }
        sizes.push(count);
    }
    (labels, sizes)
}

/// Grow a boolean mask by `iters` 4-connected dilation passes.
fn dilate(mask: &mut [bool], w: usize, h: usize, iters: u32) {
    for _ in 0..iters {
        let src = mask.to_vec();
        for p in 0..w * h {
            if src[p] {
                continue;
            }
            let (x, y) = (p % w, p / w);
            let hit = (x > 0 && src[p - 1])
                || (x + 1 < w && src[p + 1])
                || (y > 0 && src[p - w])
                || (y + 1 < h && src[p + w]);
            if hit {
                mask[p] = true;
            }
        }
    }
}

/// Pick the subject blob: the component containing the face centre if given and
/// foreground there, else the largest component. Returns the keep-mask (before
/// dilation). All-false if there is no foreground.
fn isolate_subject(raw: &[f32], rw: u32, rh: u32, face_center: Option<(u32, u32)>) -> Vec<bool> {
    let (w, h) = (rw as usize, rh as usize);
    let mask: Vec<bool> = raw.iter().map(|&v| v > SUBJECT_THRESH).collect();
    let (labels, sizes) = label_components(&mask, w, h);
    if sizes.len() <= 1 {
        return vec![false; w * h];
    }
    // Prefer the blob under the face centre.
    let mut chosen = 0u32;
    if let Some((cx, cy)) = face_center {
        let idx = (cy.min(rh - 1) as usize) * w + cx.min(rw - 1) as usize;
        if labels[idx] != 0 {
            chosen = labels[idx];
        }
    }
    if chosen == 0 {
        // Largest component.
        let mut best = (0u32, 0usize);
        for (id, &sz) in sizes.iter().enumerate().skip(1) {
            if sz > best.1 {
                best = (id as u32, sz);
            }
        }
        chosen = best.0;
    }
    labels.iter().map(|&l| l == chosen).collect()
}

/// Smoothstep the raw alpha with a transparent floor / opaque ceiling.
#[inline]
fn shape_alpha(a: f32) -> f32 {
    if a <= ALPHA_LO {
        return 0.0;
    }
    if a >= ALPHA_HI {
        return 1.0;
    }
    let t = (a - ALPHA_LO) / (ALPHA_HI - ALPHA_LO);
    t * t * (3.0 - 2.0 * t)
}

struct MatteResult {
    /// Cleaned full-res (cw×ch) alpha matte, or `None` when matting was skipped
    /// (no model, or no real subject) — caller then tiles the photo as-is.
    matte: Option<GrayImage>,
    matted: bool,
    subject_found: Option<bool>,
}

/// MODNet matte → connected-component cleanup → alpha shaping → feather. Returns
/// a full-res alpha matte for compositing (does not composite here, so the
/// subject can be tone-corrected first).
fn compute_matte(modnet: Option<&Mutex<Session>>, fg: &RgbImage, face: Option<FaceBox>) -> anyhow::Result<MatteResult> {
    let cw = fg.width();
    let ch = fg.height();

    let session = match modnet {
        Some(s) => s,
        None => return Ok(MatteResult { matte: None, matted: false, subject_found: None }),
    };

    let (rw, rh) = model_dims(ch, cw);
    let model_img = imageops::resize(fg, rw, rh, imageops::FilterType::Triangle);

    // NCHW, normalised to [-1, 1].
    let plane = (rh * rw) as usize;
    let mut chw = vec![0f32; 3 * plane];
    for (i, px) in model_img.pixels().enumerate() {
        chw[i] = (px.0[0] as f32 - 127.5) / 127.5;
        chw[plane + i] = (px.0[1] as f32 - 127.5) / 127.5;
        chw[2 * plane + i] = (px.0[2] as f32 - 127.5) / 127.5;
    }

    let outputs = run_session(session, vec![1, 3, rh as i64, rw as i64], chw)?;
    let raw = &outputs[0].data; // rh*rw, 0..1

    // Coverage gate: skip "removal" when there is no real subject.
    let coverage = raw.iter().map(|v| v.clamp(0.0, 1.0)).sum::<f32>() / raw.len() as f32;
    if coverage < SUBJECT_MIN {
        return Ok(MatteResult { matte: None, matted: false, subject_found: Some(false) });
    }

    // Drop stray background blobs: keep only the subject component.
    let face_center = face.map(|b| {
        let cx = (((b.x1 + b.x2) / 2.0) * (rw as f32 / cw as f32)).round();
        let cy = (((b.y1 + b.y2) / 2.0) * (rh as f32 / ch as f32)).round();
        (cx.clamp(0.0, rw as f32 - 1.0) as u32, cy.clamp(0.0, rh as f32 - 1.0) as u32)
    });
    let mut keep = isolate_subject(raw, rw, rh, face_center);
    dilate(&mut keep, rw as usize, rh as usize, KEEP_DILATE_ITERS);

    // Shape alpha (transparent outside the kept blob) → 8-bit gray at model res.
    let mut matte8 = GrayImage::new(rw, rh);
    for (i, px) in matte8.pixels_mut().enumerate() {
        let a = if keep[i] { shape_alpha(raw[i].clamp(0.0, 1.0)) } else { 0.0 };
        px.0 = [(a * 255.0).round() as u8];
    }
    // Upscale to working res + edge feather.
    let matte_full = imageops::blur(&imageops::resize(&matte8, cw, ch, imageops::FilterType::Triangle), FEATHER_SIGMA);

    Ok(MatteResult { matte: Some(matte_full), matted: true, subject_found: Some(true) })
}

/// Composite `fg` over the solid `bg` using `matte` (per-pixel alpha). When
/// there is no matte, the photo passes through unchanged. Operates on the raw
/// byte buffers (no per-pixel `get_pixel`/modulo).
fn composite(fg: RgbImage, matte: Option<&GrayImage>, bg: (u8, u8, u8)) -> RgbImage {
    let m = match matte {
        Some(m) => m,
        None => return fg,
    };
    let (w, h) = (fg.width(), fg.height());
    let f = fg.as_raw();
    let mr = m.as_raw();
    let (br, bgc, bb) = (bg.0 as f32, bg.1 as f32, bg.2 as f32);
    let mut out = vec![0u8; (w * h * 3) as usize];
    for i in 0..(w * h) as usize {
        let a = mr[i] as f32 / 255.0;
        let ia = 1.0 - a;
        out[i * 3] = clamp_u8(f[i * 3] as f32 * a + br * ia);
        out[i * 3 + 1] = clamp_u8(f[i * 3 + 1] as f32 * a + bgc * ia);
        out[i * 3 + 2] = clamp_u8(f[i * 3 + 2] as f32 * a + bb * ia);
    }
    RgbImage::from_raw(w, h, out).expect("composite buffer size")
}

// ---- Auto-enhancement -------------------------------------------------------
/// Auto white-balance (damped gray-world over the subject), auto-exposure
/// (face-luminance → target), and a mild contrast lift — applied in place to
/// `fg` before compositing, so the replaced background stays the exact preset
/// colour. Stats come from the subject (matte-weighted) and the face box.
fn enhance_subject(fg: &mut RgbImage, matte: Option<&GrayImage>, face: Option<FaceBox>) {
    let (w, h) = (fg.width(), fg.height());
    let n = (w * h) as usize;

    // --- white-balance gains from the subject ---
    let (mut sr, mut sg, mut sb, mut wsum) = (0f64, 0f64, 0f64, 0f64);
    {
        let f = fg.as_raw();
        match matte {
            Some(m) => {
                let mr = m.as_raw();
                for i in 0..n {
                    let a = mr[i] as f64 / 255.0;
                    if a <= 0.0 {
                        continue;
                    }
                    sr += f[i * 3] as f64 * a;
                    sg += f[i * 3 + 1] as f64 * a;
                    sb += f[i * 3 + 2] as f64 * a;
                    wsum += a;
                }
            }
            None => {
                for i in 0..n {
                    sr += f[i * 3] as f64;
                    sg += f[i * 3 + 1] as f64;
                    sb += f[i * 3 + 2] as f64;
                }
                wsum = n as f64;
            }
        }
    }
    let (mut gr, mut gg, mut gb) = (1.0f32, 1.0f32, 1.0f32);
    if wsum > 0.0 {
        let (mr, mg, mb) = (sr / wsum, sg / wsum, sb / wsum);
        let gray = (mr + mg + mb) / 3.0;
        let gain = |mean: f64| -> f32 {
            if mean < 1.0 {
                return 1.0;
            }
            (((gray / mean - 1.0) * WB_DAMP as f64 + 1.0) as f32).clamp(WB_GAIN_MIN, WB_GAIN_MAX)
        };
        gr = gain(mr);
        gg = gain(mg);
        gb = gain(mb);
    }

    // --- exposure gain from the face-region luminance median ---
    let mut expo = 1.0f32;
    if let Some(b) = face {
        let x0 = b.x1.max(0.0) as u32;
        let y0 = b.y1.max(0.0) as u32;
        let x1 = (b.x2.min(w as f32) as u32).max(x0 + 1);
        let y1 = (b.y2.min(h as f32) as u32).max(y0 + 1);
        let mut hist = [0u32; 256];
        let mut total = 0u32;
        for y in y0..y1.min(h) {
            for x in x0..x1.min(w) {
                let p = fg.get_pixel(x, y).0;
                let l = (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) as usize;
                hist[l.min(255)] += 1;
                total += 1;
            }
        }
        if total > 0 {
            let mid = total / 2;
            let (mut acc, mut median) = (0u32, 128usize);
            for (l, &c) in hist.iter().enumerate() {
                acc += c;
                if acc >= mid {
                    median = l;
                    break;
                }
            }
            expo = (EXPO_TARGET / (median as f32).max(1.0)).clamp(EXPO_GAIN_MIN, EXPO_GAIN_MAX);
        }
    }

    // --- apply WB × exposure, then a mild contrast lift around mid-grey ---
    let cr = gr * expo;
    let cg = gg * expo;
    let cb = gb * expo;
    for px in fg.pixels_mut() {
        let r = (px.0[0] as f32 * cr - 128.0) * CONTRAST + 128.0;
        let g = (px.0[1] as f32 * cg - 128.0) * CONTRAST + 128.0;
        let b = (px.0[2] as f32 * cb - 128.0) * CONTRAST + 128.0;
        px.0 = [clamp_u8(r), clamp_u8(g), clamp_u8(b)];
    }
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

/// Measure head roll from a WFLW-98 landmark model run on the padded face crop;
/// return the degrees to rotate (CSS-clockwise) to level the eyes, clamped to
/// `±MAX_STRAIGHTEN_DEG`. Any uncertainty (no model, unexpected output, bad
/// geometry) returns 0.0 so straightening simply no-ops.
fn straighten_angle(landmark: Option<&Mutex<Session>>, fg: &RgbImage, face: FaceBox) -> f32 {
    let session = match landmark {
        Some(s) => s,
        None => return 0.0,
    };
    let (iw, ih) = (fg.width() as f32, fg.height() as f32);
    let cx = (face.x1 + face.x2) / 2.0;
    let cy = (face.y1 + face.y2) / 2.0;
    let half = (face.x2 - face.x1).max(face.y2 - face.y1) * 0.65; // pad past the box
    let x0 = (cx - half).max(0.0);
    let y0 = (cy - half).max(0.0);
    let x1 = (cx + half).min(iw);
    let y1 = (cy + half).min(ih);
    let cw = (x1 - x0) as u32;
    let ch = (y1 - y0) as u32;
    if cw < 8 || ch < 8 {
        return 0.0;
    }
    let crop = imageops::crop_imm(fg, x0 as u32, y0 as u32, cw, ch).to_image();
    let inp = imageops::resize(&crop, 112, 112, imageops::FilterType::Triangle);

    let plane = 112 * 112usize;
    let mut data = vec![0f32; 3 * plane];
    for (i, px) in inp.pixels().enumerate() {
        data[i] = px.0[0] as f32 / 255.0;
        data[plane + i] = px.0[1] as f32 / 255.0;
        data[2 * plane + i] = px.0[2] as f32 / 255.0;
    }
    let outputs = match run_session(session, vec![1, 3, 112, 112], data) {
        Ok(o) => o,
        Err(_) => return 0.0,
    };
    // Find the 98-point landmark output (1×196). Gating on the exact length keeps
    // an unexpected model from producing a bogus rotation.
    let lm = outputs.iter().find(|t| t.data.len() == LM_LEN_98);
    let lm = match lm {
        Some(t) => &t.data,
        None => return 0.0,
    };
    let (lx, ly) = (lm[LM_LEFT_PUPIL * 2], lm[LM_LEFT_PUPIL * 2 + 1]);
    let (rx, ry) = (lm[LM_RIGHT_PUPIL * 2], lm[LM_RIGHT_PUPIL * 2 + 1]);
    let ang = (ry - ly).atan2(rx - lx).to_degrees();
    if !ang.is_finite() {
        return 0.0;
    }
    (-ang).clamp(-MAX_STRAIGHTEN_DEG, MAX_STRAIGHTEN_DEG)
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
    /// Total rotation applied (auto-straighten + manual nudge), in degrees.
    #[serde(rename = "appliedAngle")]
    pub applied_angle: f32,
    pub bg: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "jobId")]
    pub job_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer: Option<String>,
}

/// Internal result of the (blocking) CPU pipeline.
struct PreparedOut {
    id: String,
    matted: bool,
    subject_found: Option<bool>,
    face_detected: bool,
    applied_angle: f32,
}

pub async fn prepare(state: &SharedState, buffer: Vec<u8>, bg: Option<String>, rotate: Option<f32>) -> AppResult<PrepareResult> {
    let bg_rgb = resolve_bg(&bg);
    let modnet = state.passport.modnet(&state.config);
    let face_sess = state.passport.face(&state.config);
    let landmark_sess = state.passport.landmark(&state.config);
    let out_dir = prepared_dir(&state.config);
    let manual = rotate.unwrap_or(0.0).clamp(-MANUAL_ROTATE_MAX, MANUAL_ROTATE_MAX);

    // All decode + inference + pixel work runs on a blocking thread so the async
    // runtime stays free (inference would otherwise stall every other request).
    let out = tokio::task::spawn_blocking(move || -> anyhow::Result<PreparedOut> {
        let img = crate::imaging::load_oriented(&buffer)?;
        let (w, h) = (img.width(), img.height());
        let scale = (COMPOSITE_MAX as f32 / w as f32).min(COMPOSITE_MAX as f32 / h as f32).min(1.0);
        let mut fg = if scale < 1.0 {
            imageops::resize(&img.to_rgb8(), ((w as f32 * scale) as u32).max(1), ((h as f32 * scale) as u32).max(1), imageops::FilterType::Lanczos3)
        } else {
            img.to_rgb8()
        };

        // Auto-straighten (landmark roll) + manual nudge, then re-detect the face
        // on the rotated image so the crop is centred on the level head.
        let face0 = detect_face(face_sess.as_deref(), &fg);
        let auto = face0.map(|b| straighten_angle(landmark_sess.as_deref(), &fg, b)).unwrap_or(0.0);
        let total = (auto + manual).clamp(-(MAX_STRAIGHTEN_DEG + MANUAL_ROTATE_MAX), MAX_STRAIGHTEN_DEG + MANUAL_ROTATE_MAX);
        let face = if total.abs() > 0.05 {
            fg = crate::imaging::rotate_rgb_fill(&fg, total, Rgb([bg_rgb.0, bg_rgb.1, bg_rgb.2]));
            detect_face(face_sess.as_deref(), &fg)
        } else {
            face0
        };

        let matte = compute_matte(modnet.as_deref(), &fg, face)?;
        enhance_subject(&mut fg, matte.matte.as_ref(), face);
        let composited = composite(fg, matte.matte.as_ref(), bg_rgb);

        let cw = composited.width();
        let ch = composited.height();
        let rect = match face {
            Some(b) => passport_crop(cw, ch, b),
            None => fallback_crop(cw, ch),
        };
        let cropped = imageops::crop_imm(&composited, rect.left, rect.top, rect.width.max(1), rect.height.max(1)).to_image();
        let out = imageops::unsharpen(&cover_resize(&cropped, OUT_W, OUT_H), SHARPEN_SIGMA, SHARPEN_AMT);

        let id = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(&out_dir)?;
        out.save(out_dir.join(format!("{id}.png")))?;
        Ok(PreparedOut {
            id,
            matted: matte.matted,
            subject_found: matte.subject_found,
            face_detected: face.is_some(),
            applied_angle: total,
        })
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
    .map_err(|e| AppError::internal(e.to_string()))?;

    state.db.with(|c| {
        activity::log(
            c,
            None,
            "passport_prepared",
            Some(&format!(
                "Photo prepared (matted={}, subject={:?}, face={}, rot={:.1}°)",
                out.matted, out.subject_found, out.face_detected, out.applied_angle
            )),
        )
    });
    Ok(PrepareResult {
        id: out.id,
        matted: out.matted,
        subject_found: out.subject_found,
        face_detected: out.face_detected,
        applied_angle: out.applied_angle,
        bg: bg.unwrap_or_else(|| "light-blue".into()),
        job_id: None,
        label: None,
        customer: None,
    })
}

pub async fn prepare_from_job(state: &SharedState, job_id: i64, bg: Option<String>, rotate: Option<f32>) -> AppResult<PrepareResult> {
    let job = state.db.with(|c| jobs::get_job(c, job_id))?.ok_or_else(|| AppError::internal("job not found"))?;
    if job.job_type.as_deref() != Some("image") {
        return Err(AppError::internal("passport photos must be images (jpg/png)"));
    }
    let src = media::absolute_path(&state.config, &job.storage_folder, &job.filename);
    if !src.exists() {
        return Err(AppError::internal("source image file missing"));
    }
    let buffer = std::fs::read(&src)?;
    let mut res = prepare(state, buffer, bg, rotate).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_distinct_blobs() {
        // [#][.][#][#] → two components of sizes 1 and 2.
        let mask = [true, false, true, true];
        let (labels, sizes) = label_components(&mask, 4, 1);
        assert_eq!(labels[0], 1);
        assert_eq!(labels[1], 0); // background
        assert_eq!(labels[2], labels[3]); // same blob
        assert_ne!(labels[0], labels[2]);
        assert_eq!(sizes[1], 1);
        assert_eq!(sizes[2], 2);
    }

    #[test]
    fn isolate_keeps_largest_when_no_face() {
        // Left 2 px = subject blob, right 1 px = stray bg object. Build a raw
        // matte (row-major, w=5) with both above threshold but disconnected.
        let rw = 5u32;
        let rh = 1u32;
        let raw = [0.9f32, 0.9, 0.0, 0.0, 0.95];
        let keep = isolate_subject(&raw, rw, rh, None);
        assert!(keep[0] && keep[1], "largest blob kept");
        assert!(!keep[4], "stray single-px blob dropped");
    }

    #[test]
    fn isolate_prefers_face_blob_over_larger() {
        // Bigger blob on the left, smaller blob on the right under the face.
        let rw = 6u32;
        let rh = 1u32;
        let raw = [0.9f32, 0.9, 0.9, 0.0, 0.9, 0.9];
        // Face centre over index 5 (the smaller right blob).
        let keep = isolate_subject(&raw, rw, rh, Some((5, 0)));
        assert!(keep[4] && keep[5], "face blob kept");
        assert!(!keep[0] && !keep[2], "larger non-face blob dropped");
    }

    #[test]
    fn dilate_grows_plus_shape() {
        // Single lit pixel in a 3×3 → its 4-neighbours light up after one pass.
        let mut m = vec![false; 9];
        m[4] = true;
        dilate(&mut m, 3, 3, 1);
        let lit: usize = m.iter().filter(|&&b| b).count();
        assert_eq!(lit, 5); // centre + up/down/left/right
        assert!(m[1] && m[3] && m[5] && m[7]);
        assert!(!m[0] && !m[2]); // diagonals stay off (4-connectivity)
    }

    #[test]
    fn shape_alpha_floor_ceiling_and_midband() {
        assert_eq!(shape_alpha(0.0), 0.0);
        assert_eq!(shape_alpha(ALPHA_LO - 0.01), 0.0); // haze → transparent
        assert_eq!(shape_alpha(1.0), 1.0);
        assert_eq!(shape_alpha(ALPHA_HI + 0.01), 1.0); // solid → opaque
        let mid = shape_alpha(0.5);
        assert!(mid > 0.0 && mid < 1.0, "soft transition preserved");
    }

    #[test]
    fn composite_blends_with_alpha() {
        let fg = RgbImage::from_fn(2, 1, |x, _| if x == 0 { Rgb([200, 100, 50]) } else { Rgb([10, 20, 30]) });
        let mut matte = GrayImage::new(2, 1);
        matte.put_pixel(0, 0, image::Luma([255])); // opaque → fg
        matte.put_pixel(1, 0, image::Luma([0])); // transparent → bg
        let out = composite(fg, Some(&matte), (0, 0, 255));
        assert_eq!(out.get_pixel(0, 0).0, [200, 100, 50]);
        assert_eq!(out.get_pixel(1, 0).0, [0, 0, 255]);
    }

    #[test]
    fn composite_passthrough_without_matte() {
        let fg = RgbImage::from_pixel(2, 2, Rgb([7, 8, 9]));
        let out = composite(fg.clone(), None, (0, 0, 0));
        assert_eq!(out, fg);
    }
}
