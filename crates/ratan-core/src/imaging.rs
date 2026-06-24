//! Image processing presets — the `sharp` pipeline from
//! `backend/src/services/processing/index.js`, reimplemented with the `image`
//! crate. EXIF auto-orient → contain-fit onto a white A4 canvas → optional
//! grayscale → brightness×contrast → optional sharpen → full-page A4 PDF.
//!
//! Output is visually equivalent, not byte-identical to libvips (per the plan).

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, Rgb, RgbImage};

/// A4 at 300 dpi (px) and in PDF points.
pub const A4_W: u32 = 2480;
pub const A4_H: u32 = 3508;
pub const A4_PT_W: f64 = 595.28;
pub const A4_PT_H: f64 = 841.89;

#[derive(Clone, Copy)]
pub struct Preset {
    pub grayscale: bool,
    pub sharpen: bool,
    pub brightness: f32,
    pub contrast: f32,
    /// Invert the tones after the grayscale/brightness/contrast stage.
    pub invert: bool,
    /// If Some(t), binarize to strict black-or-white: luma < t → black.
    pub threshold: Option<u8>,
    /// Use the full document-scan pipeline (flat-field illumination removal →
    /// tone curve → unsharp) instead of the standard per-pixel pipeline. When
    /// true, all other fields are ignored.
    pub doc_scan: bool,
}

/// Resolve a preset by key (mirrors `PRESETS` in processing/index.js).
pub fn preset(name: &str) -> Option<Preset> {
    Some(match name {
        "scan_pdf"      => Preset { grayscale: true,  sharpen: true,  brightness: 1.05, contrast: 1.2, invert: false, threshold: None,        doc_scan: false },
        "bw"            => Preset { grayscale: true,  sharpen: false, brightness: 1.0,  contrast: 1.0, invert: false, threshold: None,        doc_scan: false },
        "color"         => Preset { grayscale: false, sharpen: true,  brightness: 1.0,  contrast: 1.0, invert: false, threshold: None,        doc_scan: false },
        // Document-scan pipeline: flat-field illumination removal → tone curve → unsharp.
        "high_contrast" => Preset { grayscale: true,  sharpen: true,  brightness: 1.0,  contrast: 1.0, invert: false, threshold: None,        doc_scan: true  },
        "a4_resize"     => Preset { grayscale: false, sharpen: false, brightness: 1.0,  contrast: 1.0, invert: false, threshold: None,        doc_scan: false },
        "inverted"      => Preset { grayscale: true,  sharpen: false, brightness: 1.0,  contrast: 1.0, invert: true,  threshold: None,        doc_scan: false },
        _ => return None,
    })
}

fn read_orientation(bytes: &[u8]) -> u32 {
    let mut cur = std::io::Cursor::new(bytes);
    if let Ok(exif) = exif::Reader::new().read_from_container(&mut cur) {
        if let Some(f) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
            if let Some(v) = f.value.get_uint(0) {
                return v;
            }
        }
    }
    1
}

/// Decode an image and apply its EXIF orientation (sharp's implicit `.rotate()`).
pub fn load_oriented(bytes: &[u8]) -> anyhow::Result<DynamicImage> {
    let o = read_orientation(bytes);
    Ok(apply_orientation(image::load_from_memory(bytes)?, o))
}

/// Apply an EXIF orientation (1..8) — the equivalent of sharp's `.rotate()`.
fn apply_orientation(img: DynamicImage, o: u32) -> DynamicImage {
    match o {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

#[inline]
pub fn clamp_u8(v: f32) -> u8 {
    if v <= 0.0 {
        0
    } else if v >= 255.0 {
        255
    } else {
        v.round() as u8
    }
}

/// Apply a preset's pixel pipeline to an RGB canvas.
///
/// When `p.doc_scan` is true, delegates to the full document-scan pipeline
/// (flat-field illumination removal → tone curve → unsharp mask).
/// Otherwise runs the standard per-pixel pipeline:
///   1. Grayscale (optional)
///   2. Brightness × contrast
///   3. Invert (optional)
///   4. Unsharp mask (optional)
///   5. Threshold binarization (optional)
pub fn apply_preset_pixels(canvas: RgbImage, p: &Preset) -> RgbImage {
    if p.doc_scan {
        return apply_high_contrast(canvas);
    }

    let mut canvas = canvas;
    let factor = p.brightness * p.contrast;
    for px in canvas.pixels_mut() {
        let [r, g, b] = px.0;
        let (mut r, mut g, mut b) = (r as f32, g as f32, b as f32);
        if p.grayscale {
            let y = 0.299 * r + 0.587 * g + 0.114 * b;
            r = y;
            g = y;
            b = y;
        }
        let mut out = [clamp_u8(r * factor), clamp_u8(g * factor), clamp_u8(b * factor)];
        if p.invert {
            out = [255 - out[0], 255 - out[1], 255 - out[2]];
        }
        px.0 = out;
    }
    let mut canvas = if p.sharpen {
        image::imageops::unsharpen(&canvas, 1.0, 1)
    } else {
        canvas
    };
    if let Some(t) = p.threshold {
        for px in canvas.pixels_mut() {
            let luma = px.0[0];
            px.0 = if luma < t { [0, 0, 0] } else { [255, 255, 255] };
        }
    }
    canvas
}

// ── High-contrast document-scan pipeline ─────────────────────────────────────
//
// Produces a clean "scanned document" look: crisp dark text on a bright, even,
// near-white background — NOT a 1-bit monotone threshold. Grayscale tonality is
// preserved so text edges stay smooth and the result reads naturally.
//
// Pipeline:
//   1. Grayscale (ITU-R BT.709 luma weights).
//   2. Background (illumination) estimate — a local maximum followed by a wide
//      box blur. The max-filter samples the paper brightness while ignoring the
//      darker text/marks; the blur turns it into a smooth, slowly-varying
//      lighting field.
//   3. Flat-field normalisation — divide each pixel by its local background
//      (`pixel / bg × 255`). This cancels shadows and uneven lighting, pushing
//      the paper to a uniform near-white regardless of how the photo was lit.
//   4. Tone curve — black/white-point levels stretch plus a mild gamma that
//      deepens the text without crushing the edge anti-aliasing (so it never
//      becomes a harsh monotone bitmap).
//   5. Unsharp mask — crisps up the text strokes for a sharp scanned feel.

/// Full document-scan pipeline. Called when `Preset.doc_scan` is true.
pub fn apply_high_contrast(src: RgbImage) -> RgbImage {
    let w = src.width() as usize;
    let h = src.height() as usize;
    if w == 0 || h == 0 {
        return src;
    }

    // 1. Grayscale (BT.709 weights for accurate perceptual luminance).
    let gray: Vec<u8> = src
        .pixels()
        .map(|p| {
            let [r, g, b] = p.0;
            (0.2126 * r as f32 + 0.7152 * g as f32 + 0.0722 * b as f32) as u8
        })
        .collect();

    // 2. Background illumination estimate: local max (samples paper level while
    //    ignoring dark text) then a wide blur to smooth it into a lighting field.
    let min_dim = w.min(h);
    let r_max = (min_dim / 20).clamp(8, 35);
    let r_blur = (min_dim / 12).clamp(12, 60);
    let lifted = separable_max(&gray, w, h, r_max);
    let bg = separable_blur(&lifted, w, h, r_blur);

    // 3. Flat-field normalise + 4. tone curve (levels + gamma).
    //    LO/HI are the black/white points after normalisation; GAMMA > 1 deepens
    //    the text while leaving the (already ~white) background untouched.
    const LO: f32 = 25.0;
    const HI: f32 = 200.0;
    const GAMMA: f32 = 1.5;
    let span = HI - LO;
    let mut out = vec![0u8; w * h];
    for i in 0..w * h {
        let bg_v = (bg[i] as f32).max(1.0);
        let flat = (gray[i] as f32 / bg_v * 255.0).min(255.0);
        let t = ((flat - LO) / span).clamp(0.0, 1.0).powf(GAMMA);
        out[i] = (t * 255.0) as u8;
    }

    // 5. Unsharp mask for crisp text edges (mild — avoids ringing halos).
    let rgb = gray_to_rgb(&out, w as u32, h as u32);
    image::imageops::unsharpen(&rgb, 0.8, 2)
}

/// Separable sliding-window maximum with a square `(2r+1)` window. O(w·h):
/// a horizontal pass then a vertical pass, each via a monotonic deque.
/// Used to estimate the paper brightness ignoring dark text strokes.
fn separable_max(src: &[u8], w: usize, h: usize, r: usize) -> Vec<u8> {
    let mut tmp = vec![0u8; w * h];
    let mut line = vec![0u8; w.max(h)];
    let mut outl = vec![0u8; w.max(h)];

    // Horizontal pass (rows are contiguous).
    for y in 0..h {
        slide_max_1d(&src[y * w..y * w + w], r, &mut outl[..w]);
        tmp[y * w..y * w + w].copy_from_slice(&outl[..w]);
    }
    // Vertical pass (gather each column into a line buffer).
    let mut dst = vec![0u8; w * h];
    for x in 0..w {
        for y in 0..h {
            line[y] = tmp[y * w + x];
        }
        slide_max_1d(&line[..h], r, &mut outl[..h]);
        for y in 0..h {
            dst[y * w + x] = outl[y];
        }
    }
    dst
}

/// 1-D centred sliding-window maximum (window radius `r`) via a monotonic deque.
fn slide_max_1d(line: &[u8], r: usize, out: &mut [u8]) {
    let n = line.len();
    let mut dq: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    for i in 0..n {
        while let Some(&b) = dq.back() {
            if line[b] <= line[i] {
                dq.pop_back();
            } else {
                break;
            }
        }
        dq.push_back(i);
        // Emit output for position p once the right edge has advanced r past it.
        if i >= r {
            let p = i - r;
            let left = p.saturating_sub(r);
            while let Some(&f) = dq.front() {
                if f < left {
                    dq.pop_front();
                } else {
                    break;
                }
            }
            out[p] = line[*dq.front().unwrap()];
        }
    }
    // Tail: positions whose window right-edge would run past the end.
    for p in n.saturating_sub(r)..n {
        let left = p.saturating_sub(r);
        while let Some(&f) = dq.front() {
            if f < left {
                dq.pop_front();
            } else {
                break;
            }
        }
        if let Some(&f) = dq.front() {
            out[p] = line[f];
        }
    }
}

/// Separable box blur with a `(2r+1)` window via running sums. O(w·h).
fn separable_blur(src: &[u8], w: usize, h: usize, r: usize) -> Vec<u8> {
    let mut tmp = vec![0u8; w * h];
    let mut line = vec![0u8; w.max(h)];
    let mut outl = vec![0u8; w.max(h)];

    for y in 0..h {
        blur_1d(&src[y * w..y * w + w], r, &mut outl[..w]);
        tmp[y * w..y * w + w].copy_from_slice(&outl[..w]);
    }
    let mut dst = vec![0u8; w * h];
    for x in 0..w {
        for y in 0..h {
            line[y] = tmp[y * w + x];
        }
        blur_1d(&line[..h], r, &mut outl[..h]);
        for y in 0..h {
            dst[y * w + x] = outl[y];
        }
    }
    dst
}

/// 1-D centred box blur (window radius `r`) via an incremental running sum.
fn blur_1d(line: &[u8], r: usize, out: &mut [u8]) {
    let n = line.len();
    if n == 0 {
        return;
    }
    let init = r.min(n - 1);
    let mut sum: u32 = 0;
    for v in &line[..=init] {
        sum += *v as u32;
    }
    let mut cnt = (init + 1) as u32;
    for i in 0..n {
        out[i] = (sum / cnt) as u8;
        let add = i + 1 + r;
        if add < n {
            sum += line[add] as u32;
            cnt += 1;
        }
        if i >= r {
            sum -= line[i - r] as u32;
            cnt -= 1;
        }
    }
}

/// Pack a grayscale byte slice into an [`RgbImage`].
fn gray_to_rgb(gray: &[u8], w: u32, h: u32) -> RgbImage {
    let raw: Vec<u8> = gray.iter().flat_map(|&g| [g, g, g]).collect();
    RgbImage::from_raw(w, h, raw).unwrap()
}

// ── Rotation helpers (used by collage and passport) ──────────────────────────

/// Rotate an RGB image by `degrees` (clockwise, like CSS `rotate()`) about its
/// center, expanding the canvas to the rotated bounding box and filling the
/// uncovered corners with white. Bilinear sampling keeps edges smooth.
pub fn rotate_rgb(src: &RgbImage, degrees: f32) -> RgbImage {
    rotate_rgb_fill(src, degrees, Rgb([255, 255, 255]))
}

/// Like [`rotate_rgb`] but fills the uncovered corners with `fill`.
pub fn rotate_rgb_fill(src: &RgbImage, degrees: f32, fill: Rgb<u8>) -> RgbImage {
    let rad = degrees.to_radians();
    let (sin, cos) = rad.sin_cos();
    let (w, h) = (src.width() as f32, src.height() as f32);
    let nw = (w * cos.abs() + h * sin.abs()).ceil().max(1.0) as u32;
    let nh = (w * sin.abs() + h * cos.abs()).ceil().max(1.0) as u32;
    let (cx, cy) = (w / 2.0, h / 2.0);
    let (ncx, ncy) = (nw as f32 / 2.0, nh as f32 / 2.0);

    let mut out = RgbImage::from_pixel(nw, nh, fill);
    for (x, y, px) in out.enumerate_pixels_mut() {
        let dx = x as f32 + 0.5 - ncx;
        let dy = y as f32 + 0.5 - ncy;
        let sx = dx * cos + dy * sin + cx - 0.5;
        let sy = -dx * sin + dy * cos + cy - 0.5;
        if sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5 {
            continue;
        }
        let x0 = sx.floor().clamp(0.0, w - 1.0);
        let y0 = sy.floor().clamp(0.0, h - 1.0);
        let x1 = (x0 + 1.0).min(w - 1.0);
        let y1 = (y0 + 1.0).min(h - 1.0);
        let fx = (sx - x0).clamp(0.0, 1.0);
        let fy = (sy - y0).clamp(0.0, 1.0);
        let p00 = src.get_pixel(x0 as u32, y0 as u32).0;
        let p10 = src.get_pixel(x1 as u32, y0 as u32).0;
        let p01 = src.get_pixel(x0 as u32, y1 as u32).0;
        let p11 = src.get_pixel(x1 as u32, y1 as u32).0;
        let mut o = [0u8; 3];
        for c in 0..3 {
            let top = p00[c] as f32 * (1.0 - fx) + p10[c] as f32 * fx;
            let bot = p01[c] as f32 * (1.0 - fx) + p11[c] as f32 * fx;
            o[c] = clamp_u8(top * (1.0 - fy) + bot * fy);
        }
        px.0 = o;
    }
    out
}

/// Run the preset pipeline and return a single-page A4 PDF.
pub fn render_image_to_a4_pdf(bytes: &[u8], p: &Preset) -> anyhow::Result<Vec<u8>> {
    let o = read_orientation(bytes);
    let img = apply_orientation(image::load_from_memory(bytes)?, o);

    let (w, h) = img.dimensions();
    let scale = (A4_W as f32 / w as f32).min(A4_H as f32 / h as f32);
    let nw = ((w as f32) * scale).round().max(1.0) as u32;
    let nh = ((h as f32) * scale).round().max(1.0) as u32;
    let resized = image::imageops::resize(&img.to_rgb8(), nw, nh, FilterType::CatmullRom);

    let mut canvas = RgbImage::from_pixel(A4_W, A4_H, Rgb([255, 255, 255]));
    let ox = ((A4_W.saturating_sub(nw)) / 2) as i64;
    let oy = ((A4_H.saturating_sub(nh)) / 2) as i64;
    image::imageops::overlay(&mut canvas, &resized, ox, oy);

    let canvas = apply_preset_pixels(canvas, p);

    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(canvas)
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .map_err(|e| anyhow::anyhow!("jpeg encode failed: {}", e))?;
    crate::pdf::jpeg_page(&buf.into_inner(), A4_W, A4_H, A4_PT_W, A4_PT_H, &[])
}
