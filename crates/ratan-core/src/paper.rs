//! Paper / document edge detection & crop — the "scan from a phone photo" step.
//!
//! Detects the sheet of paper in a photo and perspective-crops it to a clean
//! rectangle, like mobile scanner apps. The detector is a tiny classical
//! pipeline (no ONNX model, nothing extra to bundle): downscale → grayscale →
//! Otsu threshold → largest connected component → extreme-point corners →
//! 4-point homography warp at full resolution. Documents on a contrasting
//! surface (desk, table) is exactly the case this handles well.

use image::{GrayImage, RgbImage};

/// Working size for detection; the warp itself samples the full-res photo.
const DETECT_MAX: u32 = 900;
/// The detected quad must cover at least this fraction of the photo…
const MIN_COVERAGE: f64 = 0.06;
/// …and at most this much (≈whole frame ⇒ nothing useful to crop).
const MAX_COVERAGE: f64 = 0.985;

pub struct CroppedPage {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Detect the page in `bytes` (any image format) and return it cropped and
/// perspective-corrected as a JPEG. Errors with a readable message when no
/// page-like region is found.
pub fn detect_and_crop_page(bytes: &[u8]) -> anyhow::Result<CroppedPage> {
    let img = crate::imaging::load_oriented(bytes)?.to_rgb8();
    let (w, h) = (img.width(), img.height());

    // Downscale for detection.
    let scale = (DETECT_MAX as f32 / w as f32).min(DETECT_MAX as f32 / h as f32).min(1.0);
    let dw = ((w as f32 * scale).round() as u32).max(8);
    let dh = ((h as f32 * scale).round() as u32).max(8);
    let small = image::imageops::resize(&img, dw, dh, image::imageops::FilterType::Triangle);
    let gray = image::imageops::blur(&image::imageops::grayscale(&small), 1.2);

    // Paper is usually the bright region; if that yields nothing page-like,
    // retry assuming a dark page on a bright surface.
    let thr = otsu_threshold(&gray);
    let quad = find_page_quad(&gray, thr, false).or_else(|| find_page_quad(&gray, thr, true));
    let Some(quad) = quad else {
        anyhow::bail!("no page detected — make sure the paper contrasts with the surface behind it");
    };

    // Map corners back to full resolution.
    let sx = w as f64 / dw as f64;
    let sy = h as f64 / dh as f64;
    let src: [(f64, f64); 4] = [
        (quad[0].0 * sx, quad[0].1 * sy),
        (quad[1].0 * sx, quad[1].1 * sy),
        (quad[2].0 * sx, quad[2].1 * sy),
        (quad[3].0 * sx, quad[3].1 * sy),
    ];

    // Output size: average of opposing side lengths (keeps the page's aspect).
    let dist = |a: (f64, f64), b: (f64, f64)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
    let out_w = (((dist(src[0], src[1]) + dist(src[3], src[2])) / 2.0).round() as u32).clamp(64, w.max(h));
    let out_h = (((dist(src[0], src[3]) + dist(src[1], src[2])) / 2.0).round() as u32).clamp(64, w.max(h));

    let warped = warp_quad(&img, &src, out_w, out_h)?;

    let mut buf = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 92);
    enc.encode_image(&image::DynamicImage::ImageRgb8(warped))?;
    Ok(CroppedPage { jpeg: buf, width: out_w, height: out_h })
}

/// Otsu's method: the threshold that maximizes between-class variance.
fn otsu_threshold(gray: &GrayImage) -> u8 {
    let mut hist = [0u64; 256];
    for p in gray.pixels() {
        hist[p.0[0] as usize] += 1;
    }
    let total: u64 = hist.iter().sum();
    let sum_all: f64 = hist.iter().enumerate().map(|(i, &c)| i as f64 * c as f64).sum();

    let (mut sum_b, mut w_b) = (0f64, 0u64);
    let (mut best_t, mut best_var) = (127u8, -1f64);
    for t in 0..256usize {
        w_b += hist[t];
        if w_b == 0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0 {
            break;
        }
        sum_b += t as f64 * hist[t] as f64;
        let m_b = sum_b / w_b as f64;
        let m_f = (sum_all - sum_b) / w_f as f64;
        let var = w_b as f64 * w_f as f64 * (m_b - m_f) * (m_b - m_f);
        if var > best_var {
            best_var = var;
            best_t = t as u8;
        }
    }
    best_t
}

/// Threshold the image (optionally inverted), take the largest connected
/// component, and reduce it to a 4-corner quad ordered TL, TR, BR, BL.
/// Returns None when the component doesn't look like a page.
fn find_page_quad(gray: &GrayImage, thr: u8, inverted: bool) -> Option<[(f64, f64); 4]> {
    let (w, h) = (gray.width() as usize, gray.height() as usize);
    let on = |x: usize, y: usize| -> bool {
        let v = gray.get_pixel(x as u32, y as u32).0[0];
        if inverted { v < thr } else { v >= thr }
    };

    // Largest connected component by BFS flood fill (4-connectivity).
    let mut seen = vec![false; w * h];
    let mut best: Vec<u32> = Vec::new(); // packed x|y<<16 — small images only
    let mut stack: Vec<(usize, usize)> = Vec::new();
    for sy in 0..h {
        for sx in 0..w {
            if seen[sy * w + sx] || !on(sx, sy) {
                continue;
            }
            let mut comp: Vec<u32> = Vec::new();
            stack.push((sx, sy));
            seen[sy * w + sx] = true;
            while let Some((x, y)) = stack.pop() {
                comp.push((x as u32) | ((y as u32) << 16));
                if x > 0 && !seen[y * w + x - 1] && on(x - 1, y) { seen[y * w + x - 1] = true; stack.push((x - 1, y)); }
                if x + 1 < w && !seen[y * w + x + 1] && on(x + 1, y) { seen[y * w + x + 1] = true; stack.push((x + 1, y)); }
                if y > 0 && !seen[(y - 1) * w + x] && on(x, y - 1) { seen[(y - 1) * w + x] = true; stack.push((x, y - 1)); }
                if y + 1 < h && !seen[(y + 1) * w + x] && on(x, y + 1) { seen[(y + 1) * w + x] = true; stack.push((x, y + 1)); }
            }
            if comp.len() > best.len() {
                best = comp;
            }
        }
    }

    let area = best.len() as f64;
    let total = (w * h) as f64;
    if area / total < MIN_COVERAGE {
        return None;
    }

    // Corner heuristic: extremes of x+y and x−y pick the four corners of any
    // roughly-rectangular blob regardless of perspective tilt.
    let (mut tl, mut br, mut tr, mut bl) = ((0u32, 0u32), (0u32, 0u32), (0u32, 0u32), (0u32, 0u32));
    let (mut min_s, mut max_s, mut min_d, mut max_d) = (i64::MAX, i64::MIN, i64::MAX, i64::MIN);
    for &p in &best {
        let x = (p & 0xffff) as i64;
        let y = (p >> 16) as i64;
        if x + y < min_s { min_s = x + y; tl = (x as u32, y as u32); }
        if x + y > max_s { max_s = x + y; br = (x as u32, y as u32); }
        if x - y > max_d { max_d = x - y; tr = (x as u32, y as u32); }
        if x - y < min_d { min_d = x - y; bl = (x as u32, y as u32); }
    }
    let quad = [
        (tl.0 as f64, tl.1 as f64),
        (tr.0 as f64, tr.1 as f64),
        (br.0 as f64, br.1 as f64),
        (bl.0 as f64, bl.1 as f64),
    ];

    // The quad (not just the blob) must be a sensible part of the frame.
    let qarea = shoelace(&quad);
    if qarea / total < MIN_COVERAGE || qarea / total > MAX_COVERAGE {
        return None;
    }
    // Degenerate quads (e.g. a thin diagonal stripe) — every side must have
    // some real length.
    let min_side = 0.08 * (w.min(h) as f64);
    for i in 0..4 {
        let a = quad[i];
        let b = quad[(i + 1) % 4];
        if ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt() < min_side {
            return None;
        }
    }
    Some(quad)
}

fn shoelace(q: &[(f64, f64); 4]) -> f64 {
    let mut s = 0.0;
    for i in 0..4 {
        let (x1, y1) = q[i];
        let (x2, y2) = q[(i + 1) % 4];
        s += x1 * y2 - x2 * y1;
    }
    (s / 2.0).abs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    // A tilted white "page" on a dark desk must be found, cropped, and squared
    // up to roughly its true size.
    #[test]
    fn detects_and_crops_tilted_page() {
        let (w, h) = (1200u32, 900u32);
        let mut img = RgbImage::from_pixel(w, h, Rgb([60, 50, 45]));
        // Quad corners (TL, TR, BR, BL) of a slightly rotated A-series page.
        let quad = [(300.0, 150.0), (900.0, 200.0), (860.0, 700.0), (260.0, 650.0)];
        // Fill via point-in-polygon (the quad is convex).
        for y in 0..h {
            for x in 0..w {
                let (px, py) = (x as f64, y as f64);
                let mut inside = true;
                for i in 0..4 {
                    let (x1, y1) = quad[i];
                    let (x2, y2) = quad[(i + 1) % 4];
                    if (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1) < 0.0 {
                        inside = false;
                        break;
                    }
                }
                if inside {
                    img.put_pixel(x, y, Rgb([245, 244, 240]));
                }
            }
        }
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 92)
            .encode_image(&image::DynamicImage::ImageRgb8(img))
            .unwrap();

        let page = detect_and_crop_page(&jpeg).expect("page should be detected");
        // Sides ≈600 wide, ≈500 tall — allow slack for blur/threshold edges.
        assert!((550..=660).contains(&page.width), "width {}", page.width);
        assert!((450..=560).contains(&page.height), "height {}", page.height);
        // The crop should be mostly paper-bright pixels.
        let out = image::load_from_memory(&page.jpeg).unwrap().to_rgb8();
        let bright = out.pixels().filter(|p| p.0[0] > 180).count() as f64 / (out.width() * out.height()) as f64;
        assert!(bright > 0.95, "bright fraction {bright}");
    }

    // A flat photo with no page-like region must fail with a readable error.
    #[test]
    fn rejects_pageless_photo() {
        let img = RgbImage::from_pixel(400, 300, Rgb([100, 100, 100]));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 92)
            .encode_image(&image::DynamicImage::ImageRgb8(img))
            .unwrap();
        assert!(detect_and_crop_page(&jpeg).is_err());
    }
}

/// Perspective-warp the quad (TL,TR,BR,BL in `src` full-res coords) onto an
/// `out_w`×`out_h` rectangle, sampling the source bilinearly.
fn warp_quad(img: &RgbImage, src: &[(f64, f64); 4], out_w: u32, out_h: u32) -> anyhow::Result<RgbImage> {
    // Homography H mapping destination rect corners → source quad, solved as
    // the standard 4-point DLT 8×8 linear system.
    let dst = [
        (0.0, 0.0),
        (out_w as f64 - 1.0, 0.0),
        (out_w as f64 - 1.0, out_h as f64 - 1.0),
        (0.0, out_h as f64 - 1.0),
    ];
    let mut a = [[0f64; 9]; 8]; // augmented [8x8 | rhs]
    for i in 0..4 {
        let (x, y) = dst[i];
        let (u, v) = src[i];
        a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u, u];
        a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v, v];
    }
    // Gaussian elimination with partial pivoting.
    for col in 0..8 {
        let pivot = (col..8).max_by(|&r1, &r2| a[r1][col].abs().partial_cmp(&a[r2][col].abs()).unwrap()).unwrap();
        if a[pivot][col].abs() < 1e-12 {
            anyhow::bail!("degenerate page corners");
        }
        a.swap(col, pivot);
        for row in 0..8 {
            if row == col {
                continue;
            }
            let f = a[row][col] / a[col][col];
            for k in col..9 {
                a[row][k] -= f * a[col][k];
            }
        }
    }
    let hm: Vec<f64> = (0..8).map(|i| a[i][8] / a[i][i]).collect();
    let (h11, h12, h13, h21, h22, h23, h31, h32) =
        (hm[0], hm[1], hm[2], hm[3], hm[4], hm[5], hm[6], hm[7]);

    let (w, h) = (img.width() as f64, img.height() as f64);
    let mut out = RgbImage::new(out_w, out_h);
    for (x, y, px) in out.enumerate_pixels_mut() {
        let (xf, yf) = (x as f64, y as f64);
        let d = h31 * xf + h32 * yf + 1.0;
        let sx = (h11 * xf + h12 * yf + h13) / d;
        let sy = (h21 * xf + h22 * yf + h23) / d;
        let sx = sx.clamp(0.0, w - 1.0);
        let sy = sy.clamp(0.0, h - 1.0);
        let x0 = sx.floor();
        let y0 = sy.floor();
        let x1 = (x0 + 1.0).min(w - 1.0);
        let y1 = (y0 + 1.0).min(h - 1.0);
        let (fx, fy) = (sx - x0, sy - y0);
        let p00 = img.get_pixel(x0 as u32, y0 as u32).0;
        let p10 = img.get_pixel(x1 as u32, y0 as u32).0;
        let p01 = img.get_pixel(x0 as u32, y1 as u32).0;
        let p11 = img.get_pixel(x1 as u32, y1 as u32).0;
        let mut o = [0u8; 3];
        for c in 0..3 {
            let top = p00[c] as f64 * (1.0 - fx) + p10[c] as f64 * fx;
            let bot = p01[c] as f64 * (1.0 - fx) + p11[c] as f64 * fx;
            o[c] = (top * (1.0 - fy) + bot * fy).round().clamp(0.0, 255.0) as u8;
        }
        px.0 = o;
    }
    Ok(out)
}
