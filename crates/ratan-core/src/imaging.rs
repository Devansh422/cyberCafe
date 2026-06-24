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
    /// Use the full CLAHE-based high-contrast document pipeline instead of the
    /// standard per-pixel pipeline. When true, all other fields are ignored.
    pub clahe: bool,
}

/// Resolve a preset by key (mirrors `PRESETS` in processing/index.js).
pub fn preset(name: &str) -> Option<Preset> {
    Some(match name {
        "scan_pdf"      => Preset { grayscale: true,  sharpen: true,  brightness: 1.05, contrast: 1.2, invert: false, threshold: None,        clahe: false },
        "bw"            => Preset { grayscale: true,  sharpen: false, brightness: 1.0,  contrast: 1.0, invert: false, threshold: None,        clahe: false },
        "color"         => Preset { grayscale: false, sharpen: true,  brightness: 1.0,  contrast: 1.0, invert: false, threshold: None,        clahe: false },
        // Full document-scanning pipeline: CLAHE → adaptive threshold → median → dilate.
        "high_contrast" => Preset { grayscale: true,  sharpen: true,  brightness: 1.0,  contrast: 1.0, invert: false, threshold: None,        clahe: true  },
        "a4_resize"     => Preset { grayscale: false, sharpen: false, brightness: 1.0,  contrast: 1.0, invert: false, threshold: None,        clahe: false },
        "inverted"      => Preset { grayscale: true,  sharpen: false, brightness: 1.0,  contrast: 1.0, invert: true,  threshold: None,        clahe: false },
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
/// When `p.clahe` is true, delegates to the full CLAHE document pipeline
/// (grayscale → CLAHE → adaptive threshold → median denoise → dilate).
/// Otherwise runs the standard per-pixel pipeline:
///   1. Grayscale (optional)
///   2. Brightness × contrast
///   3. Invert (optional)
///   4. Unsharp mask (optional)
///   5. Threshold binarization (optional)
pub fn apply_preset_pixels(canvas: RgbImage, p: &Preset) -> RgbImage {
    if p.clahe {
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

// ── High-contrast document pipeline ─────────────────────────────────────────
//
// Pipeline (matches the spec):
//   1. Grayscale (ITU-R BT.709 luma weights)
//   2. CLAHE — 8×8 tile grid, clip limit 3.0 — normalises local contrast so
//      faded text becomes as dark as normal text regardless of lighting
//   3. Adaptive threshold (Bradley–Roth integral-image method) — binarises
//      based on each pixel's local neighbourhood mean rather than a global
//      value, handles uneven lighting across the card
//   4. Median 3×3 denoise — removes salt-and-pepper noise from thresholding
//      while keeping crisp text edges
//   5. Binary dilation (3×3 min filter) — expands dark (text) pixels by one
//      pixel, strengthening thin strokes so they survive printing

/// Full CLAHE-based document pipeline. Called when `Preset.clahe` is true.
pub fn apply_high_contrast(src: RgbImage) -> RgbImage {
    let (w, h) = (src.width(), src.height());

    // 1. Grayscale (BT.709 weights for accurate perceptual luminance)
    let gray: Vec<u8> = src
        .pixels()
        .map(|p| {
            let [r, g, b] = p.0;
            (0.2126 * r as f32 + 0.7152 * g as f32 + 0.0722 * b as f32) as u8
        })
        .collect();

    // 2. CLAHE
    let equalized = clahe_8x8(&gray, w as usize, h as usize);

    // 3. Adaptive threshold
    let binary = adaptive_threshold(&equalized, w as usize, h as usize);

    // 4. Median 3×3 denoise
    let denoised = median_3x3(&binary, w as usize, h as usize);

    // 5. Sharpen text edges via binary dilation (strengthens thin strokes)
    let sharpened = dilate_text(&denoised, w as usize, h as usize);

    gray_to_rgb(&sharpened, w, h)
}

/// CLAHE with an 8×8 tile grid and clip limit 3.0.
///
/// For each tile: build histogram → clip at (3 × tile_pixels / 256) →
/// redistribute excess uniformly → build CDF → derive 256-entry LUT.
/// Output pixels are bilinearly interpolated between the 4 surrounding tile LUTs.
fn clahe_8x8(gray: &[u8], w: usize, h: usize) -> Vec<u8> {
    const GX: usize = 8;
    const GY: usize = 8;
    const CLIP: f32 = 3.0;

    let tile_w = (w + GX - 1) / GX;
    let tile_h = (h + GY - 1) / GY;

    // Build one 256-entry LUT per tile.
    let mut luts = [[0u8; 256]; GX * GY];
    for ty in 0..GY {
        for tx in 0..GX {
            let x0 = tx * tile_w;
            let y0 = ty * tile_h;
            let x1 = (x0 + tile_w).min(w);
            let y1 = (y0 + tile_h).min(h);
            let n = (x1 - x0) * (y1 - y0);
            if n == 0 {
                continue;
            }

            let mut hist = [0u32; 256];
            for y in y0..y1 {
                for x in x0..x1 {
                    hist[gray[y * w + x] as usize] += 1;
                }
            }

            // Clip and redistribute excess.
            let clip_at = ((CLIP * n as f32 / 256.0).round() as u32).max(1);
            let mut excess = 0u32;
            for v in hist.iter_mut() {
                if *v > clip_at {
                    excess += *v - clip_at;
                    *v = clip_at;
                }
            }
            let add = excess / 256;
            let rem = (excess % 256) as usize;
            for v in hist.iter_mut() {
                *v += add;
            }
            for v in hist.iter_mut().take(rem) {
                *v += 1;
            }

            // Cumulative sum → normalised LUT.
            let mut cdf = 0u32;
            let lut = &mut luts[ty * GX + tx];
            for (i, &hv) in hist.iter().enumerate() {
                cdf += hv;
                lut[i] = ((cdf as f32 / n as f32) * 255.0) as u8;
            }
        }
    }

    // Bilinear interpolation between the 4 surrounding tile LUTs.
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let v = gray[y * w + x] as usize;

            // Fractional position in the tile grid (0.0 = centre of tile 0).
            let fx = (x as f32 + 0.5) / tile_w as f32 - 0.5;
            let fy = (y as f32 + 0.5) / tile_h as f32 - 0.5;

            let tx0 = (fx.floor() as isize).clamp(0, GX as isize - 1) as usize;
            let ty0 = (fy.floor() as isize).clamp(0, GY as isize - 1) as usize;
            let tx1 = (tx0 + 1).min(GX - 1);
            let ty1 = (ty0 + 1).min(GY - 1);

            let ax = (fx - tx0 as f32).clamp(0.0, 1.0);
            let ay = (fy - ty0 as f32).clamp(0.0, 1.0);

            let p00 = luts[ty0 * GX + tx0][v] as f32;
            let p10 = luts[ty0 * GX + tx1][v] as f32;
            let p01 = luts[ty1 * GX + tx0][v] as f32;
            let p11 = luts[ty1 * GX + tx1][v] as f32;

            let top = p00 + (p10 - p00) * ax;
            let bot = p01 + (p11 - p01) * ax;
            out[y * w + x] = (top + (bot - top) * ay) as u8;
        }
    }
    out
}

/// Adaptive (local) binarisation — Bradley–Roth integral-image method.
///
/// Window radius = image_min_dim / 16, clamped to [5, 75] pixels.
/// A pixel is classified as black when its value falls more than 10% below
/// the local window mean: `pixel < mean × 0.90`.
fn adaptive_threshold(gray: &[u8], w: usize, h: usize) -> Vec<u8> {
    const K: f32 = 0.10; // fraction below local mean that triggers "black"
    let half = (w.min(h) / 16).clamp(5, 75);

    // Compute 2-D integral image with u64 to avoid overflow on large tiles.
    let mut ii = vec![0u64; (w + 1) * (h + 1)];
    for y in 0..h {
        for x in 0..w {
            let v = gray[y * w + x] as u64;
            ii[(y + 1) * (w + 1) + (x + 1)] = v
                + ii[y * (w + 1) + (x + 1)]
                + ii[(y + 1) * (w + 1) + x]
                - ii[y * (w + 1) + x];
        }
    }

    let mut out = vec![255u8; w * h];
    for y in 0..h {
        let y0 = y.saturating_sub(half);
        let y1 = (y + half + 1).min(h);
        for x in 0..w {
            let x0 = x.saturating_sub(half);
            let x1 = (x + half + 1).min(w);
            let count = ((x1 - x0) * (y1 - y0)) as f32;
            let sum = (ii[y1 * (w + 1) + x1]
                - ii[y0 * (w + 1) + x1]
                - ii[y1 * (w + 1) + x0]
                + ii[y0 * (w + 1) + x0]) as f32;
            if (gray[y * w + x] as f32) < (sum / count) * (1.0 - K) {
                out[y * w + x] = 0;
            }
        }
    }
    out
}

/// 3×3 median filter. Removes isolated noise pixels while preserving edges.
fn median_3x3(img: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = img.to_vec();
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let mut win = [
                img[(y - 1) * w + (x - 1)],
                img[(y - 1) * w + x],
                img[(y - 1) * w + (x + 1)],
                img[y * w + (x - 1)],
                img[y * w + x],
                img[y * w + (x + 1)],
                img[(y + 1) * w + (x - 1)],
                img[(y + 1) * w + x],
                img[(y + 1) * w + (x + 1)],
            ];
            win.sort_unstable();
            out[y * w + x] = win[4]; // median of 9
        }
    }
    out
}

/// 3×3 binary dilation (min-filter over the neighbourhood).
/// Expands dark (text) pixels by one pixel, strengthening thin strokes.
fn dilate_text(binary: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = binary.to_vec();
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            if binary[y * w + x] != 0 {
                // Only check neighbours when the centre is white (fast path).
                let any_black = binary[(y - 1) * w + (x - 1)] == 0
                    || binary[(y - 1) * w + x] == 0
                    || binary[(y - 1) * w + (x + 1)] == 0
                    || binary[y * w + (x - 1)] == 0
                    || binary[y * w + (x + 1)] == 0
                    || binary[(y + 1) * w + (x - 1)] == 0
                    || binary[(y + 1) * w + x] == 0
                    || binary[(y + 1) * w + (x + 1)] == 0;
                if any_black {
                    out[y * w + x] = 0;
                }
            }
        }
    }
    out
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
