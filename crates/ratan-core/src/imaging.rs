//! Image processing presets — the `sharp` pipeline from
//! `backend/src/services/processing/index.js`, reimplemented with the `image`
//! crate. EXIF auto-orient → contain-fit onto a white A4 canvas → optional
//! grayscale → brightness×contrast → optional sharpen → full-page A4 PDF.
//!
//! Output is visually equivalent, not byte-identical to libvips (per the plan).

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, Rgb, RgbImage};

/// A4 at 300 dpi (px) and in PDF points.
const A4_W: u32 = 2480;
const A4_H: u32 = 3508;
const A4_PT_W: f64 = 595.28;
const A4_PT_H: f64 = 841.89;

#[derive(Clone, Copy)]
pub struct Preset {
    pub grayscale: bool,
    pub sharpen: bool,
    pub brightness: f32,
    pub contrast: f32,
}

/// Resolve a preset by key (mirrors `PRESETS` in processing/index.js).
pub fn preset(name: &str) -> Option<Preset> {
    Some(match name {
        "scan_pdf" => Preset { grayscale: true, sharpen: true, brightness: 1.05, contrast: 1.2 },
        "bw" => Preset { grayscale: true, sharpen: false, brightness: 1.0, contrast: 1.0 },
        "color" => Preset { grayscale: false, sharpen: true, brightness: 1.0, contrast: 1.0 },
        "high_contrast" => Preset { grayscale: true, sharpen: true, brightness: 1.1, contrast: 1.4 },
        "a4_resize" => Preset { grayscale: false, sharpen: false, brightness: 1.0, contrast: 1.0 },
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

    // grayscale (channels equal) then brightness×contrast (both multiplicative).
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
        px.0 = [clamp_u8(r * factor), clamp_u8(g * factor), clamp_u8(b * factor)];
    }

    let canvas = if p.sharpen { image::imageops::unsharpen(&canvas, 1.0, 1) } else { canvas };

    let raw = canvas.into_raw();
    crate::pdf::image_page(&raw, A4_W, A4_H, A4_PT_W, A4_PT_H, &[])
}
