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
    /// Invert the tones after the grayscale/brightness/contrast stage — a
    /// photographic-negative look (white page → black, ink → white).
    pub invert: bool,
}

/// Resolve a preset by key (mirrors `PRESETS` in processing/index.js).
pub fn preset(name: &str) -> Option<Preset> {
    Some(match name {
        "scan_pdf" => Preset { grayscale: true, sharpen: true, brightness: 1.05, contrast: 1.2, invert: false },
        "bw" => Preset { grayscale: true, sharpen: false, brightness: 1.0, contrast: 1.0, invert: false },
        "color" => Preset { grayscale: false, sharpen: true, brightness: 1.0, contrast: 1.0, invert: false },
        "high_contrast" => Preset { grayscale: true, sharpen: true, brightness: 1.1, contrast: 1.4, invert: false },
        "a4_resize" => Preset { grayscale: false, sharpen: false, brightness: 1.0, contrast: 1.0, invert: false },
        "inverted" => Preset { grayscale: true, sharpen: false, brightness: 1.0, contrast: 1.0, invert: true },
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
fn clamp_u8(v: f32) -> u8 {
    if v <= 0.0 {
        0
    } else if v >= 255.0 {
        255
    } else {
        v.round() as u8
    }
}

/// Apply a preset's pixel pipeline to an RGB canvas: optional grayscale, then a
/// multiplicative brightness×contrast, then optional unsharp. Shared by the
/// single-image render and the collage compositor.
pub fn apply_preset_pixels(mut canvas: RgbImage, p: &Preset) -> RgbImage {
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
    if p.sharpen {
        image::imageops::unsharpen(&canvas, 1.0, 1)
    } else {
        canvas
    }
}

/// Rotate an RGB image by `degrees` (clockwise, like CSS `rotate()`) about its
/// center, expanding the canvas to the rotated bounding box and filling the
/// uncovered corners with white. Bilinear sampling keeps edges smooth — used by
/// the collage compositor so the print matches the CSS-rotated live preview.
pub fn rotate_rgb(src: &RgbImage, degrees: f32) -> RgbImage {
    let rad = degrees.to_radians();
    let (sin, cos) = rad.sin_cos();
    let (w, h) = (src.width() as f32, src.height() as f32);
    let nw = (w * cos.abs() + h * sin.abs()).ceil().max(1.0) as u32;
    let nh = (w * sin.abs() + h * cos.abs()).ceil().max(1.0) as u32;
    let (cx, cy) = (w / 2.0, h / 2.0);
    let (ncx, ncy) = (nw as f32 / 2.0, nh as f32 / 2.0);

    let mut out = RgbImage::from_pixel(nw, nh, Rgb([255, 255, 255]));
    for (x, y, px) in out.enumerate_pixels_mut() {
        // Inverse-rotate the destination pixel back into source space.
        let dx = x as f32 + 0.5 - ncx;
        let dy = y as f32 + 0.5 - ncy;
        let sx = dx * cos + dy * sin + cx - 0.5;
        let sy = -dx * sin + dy * cos + cy - 0.5;
        if sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5 {
            continue; // stays white
        }
        // Bilinear sample, clamping to the image edge (white blend at borders
        // would fringe; clamping matches how browsers rasterize the preview).
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

    // contain-fit into A4, centered on white (sharp fit:contain + white bg).
    let (w, h) = img.dimensions();
    let scale = (A4_W as f32 / w as f32).min(A4_H as f32 / h as f32);
    let nw = ((w as f32) * scale).round().max(1.0) as u32;
    let nh = ((h as f32) * scale).round().max(1.0) as u32;
    let resized = image::imageops::resize(&img.to_rgb8(), nw, nh, FilterType::Lanczos3);

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
