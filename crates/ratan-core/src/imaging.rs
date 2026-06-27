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
// Produces a clean "scanned document" look — crisp dark text on a bright, even,
// pure-white background — that prints sharply and economically (the background
// is forced to true white so a printer lays down no ink there). It is *tonal*,
// not a 1-bit threshold: text edges keep their grayscale anti-aliasing so the
// result reads naturally instead of jagged.
//
// Reliability across document types (printed text, faint pencil, receipts,
// colour forms, IDs, well-lit or shadowed photos) comes from making every stage
// adapt to the image rather than using fixed constants:
//   1. Grayscale (ITU-R BT.709 luma weights).
//   2. Illumination estimate — a local maximum (samples the paper level *through*
//      the text) then a wide blur, giving a smooth, slowly-varying lighting field.
//   3. Flat-field normalisation — divide each pixel by its local background
//      (`pixel / bg × 255`), cancelling shadows/uneven lighting so the paper is
//      uniform regardless of how the photo was lit.
//   4. Auto tone mapping — the reliability core. The paper tone is estimated as
//      the dominant bright mode and the ink floor as a low percentile; the curve
//      stretches [black_pt, white_pt] → [0,255] with a white knee just below the
//      paper tone (so paper and brighter clip to clean white) and a mild gamma
//      that deepens text. A minimum-span guard stops near-blank pages from being
//      amplified into speckle.
//   5. Unsharp mask — crisps the strokes for a sharp, printer-friendly edge.

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
            clamp_u8(0.2126 * r as f32 + 0.7152 * g as f32 + 0.0722 * b as f32)
        })
        .collect();

    // 2. Background illumination estimate: local max (samples paper level while
    //    ignoring dark text) then a wide blur to smooth it into a lighting field.
    //    Radii scale with the image so the same physical neighbourhood is used at
    //    any resolution.
    let min_dim = w.min(h);
    let r_max = (min_dim / 20).clamp(10, 60);
    let r_blur = (min_dim / 8).clamp(24, 160);
    let lifted = separable_max(&gray, w, h, r_max);
    let bg = separable_blur(&lifted, w, h, r_blur);

    // 3. Flat-field normalise (divide by local background) and histogram the
    //    result in one pass. After this, paper sits near 255 everywhere.
    let mut flat = vec![0u8; w * h];
    let mut hist = [0u32; 256];
    for i in 0..w * h {
        let bg_v = (bg[i] as f32).max(1.0);
        let f = (gray[i] as f32 / bg_v * 255.0).min(255.0) as u8;
        flat[i] = f;
        hist[f as usize] += 1;
    }

    // 4. Auto tone mapping. Estimate paper (dominant bright mode) and the ink
    //    floor (2nd percentile), then build a 256-entry LUT that stretches
    //    [black_pt, white_pt] → [0,255] with a mild gamma.
    let total = (w * h) as u32;
    let paper = (128..=255).max_by_key(|&v| hist[v]).unwrap_or(245) as f32;
    let bp_pct = percentile(&hist, total, 0.02) as f32;
    // White point just below the paper tone → paper & brighter become pure white.
    let white_pt = (paper * 0.94).clamp(60.0, 255.0);
    // Keep a minimum tonal span so near-blank pages aren't stretched into speckle.
    const MIN_SPAN: f32 = 110.0;
    let black_pt = bp_pct.min(white_pt - MIN_SPAN).max(0.0);
    let span = (white_pt - black_pt).max(1.0);
    const GAMMA: f32 = 1.30; // deepen text without crushing edge anti-aliasing

    let mut lut = [0u8; 256];
    for (v, o) in lut.iter_mut().enumerate() {
        let t = (((v as f32) - black_pt) / span).clamp(0.0, 1.0).powf(GAMMA);
        *o = (t * 255.0) as u8;
    }
    let mut out = vec![0u8; w * h];
    for (o, &f) in out.iter_mut().zip(flat.iter()) {
        *o = lut[f as usize];
    }

    // 5. Unsharp mask for crisp, printer-friendly text edges. The threshold (3)
    //    keeps it from amplifying faint paper noise into the clean background.
    let rgb = gray_to_rgb(&out, w as u32, h as u32);
    image::imageops::unsharpen(&rgb, 1.0, 3)
}

/// Smallest tone value `v` whose cumulative histogram count reaches `frac` of
/// `total` — a percentile over a 256-bin luma histogram.
fn percentile(hist: &[u32; 256], total: u32, frac: f32) -> u8 {
    let target = (total as f32 * frac) as u32;
    let mut acc = 0u32;
    for (v, &c) in hist.iter().enumerate() {
        acc += c;
        if acc >= target {
            return v as u8;
        }
    }
    255
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

#[cfg(test)]
mod hc_tests {
    use super::*;

    /// Build an RGB test image from a per-pixel gray closure.
    fn gray_img(w: u32, h: u32, f: impl Fn(u32, u32) -> u8) -> RgbImage {
        let mut img = RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = f(x, y);
                img.put_pixel(x, y, Rgb([v, v, v]));
            }
        }
        img
    }

    /// Mean luma over a rectangle (clamped to the image).
    fn mean(img: &RgbImage, x0: u32, y0: u32, x1: u32, y1: u32) -> f32 {
        let mut s = 0u64;
        let mut n = 0u64;
        for y in y0..y1.min(img.height()) {
            for x in x0..x1.min(img.width()) {
                s += img.get_pixel(x, y).0[0] as u64;
                n += 1;
            }
        }
        s as f32 / n.max(1) as f32
    }

    // "Ink" is a fixed fraction of the *local* paper brightness (paper reflects
    // light, ink absorbs it) — the multiplicative model flat-fielding cancels.
    fn is_text_row(y: u32) -> bool {
        y >= 40 && y < 360 && ((y - 40) % 40) < 8 // 8px bars every 40px
    }

    // A page lit by a strong left→right brightness gradient (shadow) must come
    // out with a clean, uniform white background and dark text everywhere —
    // proving the flat-field stage removes uneven lighting.
    #[test]
    fn shadowed_page_flattens_to_white_with_dark_text() {
        let out = apply_high_contrast(gray_img(400, 400, |x, y| {
            let paper = 255.0 - (x as f32) * 120.0 / 400.0; // 255 (left) → 135 (right)
            if is_text_row(y) && (50..350).contains(&x) {
                (paper * 0.2) as u8
            } else {
                paper as u8
            }
        }));

        // Paper between text rows — bright & even on BOTH the lit and shadowed side.
        let paper_left = mean(&out, 60, 110, 120, 118);
        let paper_right = mean(&out, 280, 110, 340, 118);
        assert!(paper_left > 245.0, "left paper {paper_left}");
        assert!(paper_right > 245.0, "right (shadowed) paper {paper_right}");
        assert!((paper_left - paper_right).abs() < 8.0, "lighting not flattened: {paper_left} vs {paper_right}");

        // Text on the shadowed side must still be dark (bar spans y 120..128).
        let text_right = mean(&out, 280, 122, 340, 126);
        assert!(text_right < 70.0, "shadowed text not dark: {text_right}");
    }

    // Gray-on-gray (low contrast original) must be pushed apart: background to
    // white, ink clearly darker. Proves the auto black/white points adapt.
    #[test]
    fn low_contrast_doc_is_separated() {
        let out = apply_high_contrast(gray_img(300, 300, |x, y| {
            if is_text_row(y) && (50..250).contains(&x) { 150 } else { 210 }
        }));
        let paper = mean(&out, 60, 110, 240, 118);
        let ink = mean(&out, 60, 122, 240, 126);
        assert!(paper > 240.0, "paper not whitened: {paper}");
        assert!(paper - ink > 90.0, "low-contrast not separated: paper {paper} ink {ink}");
    }

    // A near-blank, slightly noisy page must stay clean white — no speckle (which
    // would waste toner). Proves the minimum-span guard.
    #[test]
    fn blank_noisy_page_stays_clean() {
        let out = apply_high_contrast(gray_img(300, 300, |x, y| {
            248u8.saturating_sub(((x ^ y) % 7) as u8) // 242..248 deterministic noise
        }));
        let m = mean(&out, 20, 20, 280, 280);
        assert!(m > 246.0, "blank page not white: {m}");
        let dark = out.pixels().filter(|p| p.0[0] < 200).count();
        let frac = dark as f32 / (out.width() * out.height()) as f32;
        assert!(frac < 0.01, "speckle on blank page: {:.4} dark", frac);
    }

    // Plain black text on white: text near-black, background pure white.
    #[test]
    fn dark_text_on_white() {
        let out = apply_high_contrast(gray_img(300, 300, |x, y| {
            if is_text_row(y) && (50..250).contains(&x) { 20 } else { 255 }
        }));
        let paper = mean(&out, 60, 110, 240, 118);
        let ink = mean(&out, 60, 122, 240, 126);
        assert!(paper > 250.0, "paper {paper}");
        assert!(ink < 45.0, "ink {ink}");
    }
}
