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
    let Some(src) = detect_quad(&img) else {
        anyhow::bail!("no page detected — make sure the paper contrasts with the surface behind it");
    };
    crop_to_quad(&img, &src, w, h)
}

/// Perspective-flatten `bytes` using user-supplied corners, given **normalized**
/// to `[0,1]` (any order — re-ordered to TL,TR,BR,BL here). Returns the warped
/// rectangle as a JPEG. Backs the manual 4-corner crop in the collage editor.
pub fn warp_corners_to_jpeg(bytes: &[u8], corners: &[[f64; 2]; 4]) -> anyhow::Result<CroppedPage> {
    let img = crate::imaging::load_oriented(bytes)?.to_rgb8();
    let (w, h) = (img.width(), img.height());
    let (wf, hf) = (w as f64, h as f64);
    let clamp_pt = |p: [f64; 2]| ((p[0].clamp(0.0, 1.0) * wf), (p[1].clamp(0.0, 1.0) * hf));
    let src = order_quad([
        clamp_pt(corners[0]),
        clamp_pt(corners[1]),
        clamp_pt(corners[2]),
        clamp_pt(corners[3]),
    ]);
    crop_to_quad(&img, &src, w, h)
}

/// Detect the document quad in a full-resolution photo. Returns corners in
/// full-res pixel coords (TL,TR,BR,BL) or `None`. Detection runs on a downscaled
/// copy for speed; corners are mapped back up.
fn detect_quad(img: &RgbImage) -> Option<[(f64, f64); 4]> {
    let (w, h) = (img.width(), img.height());
    let scale = (DETECT_MAX as f32 / w as f32).min(DETECT_MAX as f32 / h as f32).min(1.0);
    let dw = ((w as f32 * scale).round() as u32).max(8);
    let dh = ((h as f32 * scale).round() as u32).max(8);
    let small = image::imageops::resize(img, dw, dh, image::imageops::FilterType::Triangle);
    let gray = image::imageops::blur(&image::imageops::grayscale(&small), 1.2);

    // Paper is usually the bright region; if that yields nothing page-like,
    // retry assuming a dark page on a bright surface.
    let thr = otsu_threshold(&gray);
    let quad = find_page_quad(&gray, thr, false).or_else(|| find_page_quad(&gray, thr, true))?;

    // Map corners back to full resolution.
    let sx = w as f64 / dw as f64;
    let sy = h as f64 / dh as f64;
    Some([
        (quad[0].0 * sx, quad[0].1 * sy),
        (quad[1].0 * sx, quad[1].1 * sy),
        (quad[2].0 * sx, quad[2].1 * sy),
        (quad[3].0 * sx, quad[3].1 * sy),
    ])
}

/// Perspective-warp the (full-res) quad onto an upright rectangle whose size
/// preserves the page's aspect, and JPEG-encode it.
fn crop_to_quad(img: &RgbImage, src: &[(f64, f64); 4], w: u32, h: u32) -> anyhow::Result<CroppedPage> {
    // Output size: average of opposing side lengths (keeps the page's aspect).
    let dist = |a: (f64, f64), b: (f64, f64)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
    let out_w = (((dist(src[0], src[1]) + dist(src[3], src[2])) / 2.0).round() as u32).clamp(64, w.max(h));
    let out_h = (((dist(src[0], src[3]) + dist(src[1], src[2])) / 2.0).round() as u32).clamp(64, w.max(h));

    let warped = warp_quad(img, src, out_w, out_h)?;

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

    // Binary mask, then a morphological close (dilate→erode, r=1) to bridge the
    // small gaps glare, printing or compression carve out of the page region,
    // so a single connected component covers the whole card.
    let mut mask = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            let v = gray.get_pixel(x as u32, y as u32).0[0];
            mask[y * w + x] = if inverted { v < thr } else { v >= thr };
        }
    }
    let mask = morph_close(&mask, w, h);

    // Largest connected component by flood fill (4-connectivity).
    let mut seen = vec![false; w * h];
    let mut best: Vec<u32> = Vec::new(); // packed x|y<<16 — small images only
    let mut stack: Vec<(usize, usize)> = Vec::new();
    for sy in 0..h {
        for sx in 0..w {
            if seen[sy * w + sx] || !mask[sy * w + sx] {
                continue;
            }
            let mut comp: Vec<u32> = Vec::new();
            stack.push((sx, sy));
            seen[sy * w + sx] = true;
            while let Some((x, y)) = stack.pop() {
                comp.push((x as u32) | ((y as u32) << 16));
                if x > 0 && !seen[y * w + x - 1] && mask[y * w + x - 1] { seen[y * w + x - 1] = true; stack.push((x - 1, y)); }
                if x + 1 < w && !seen[y * w + x + 1] && mask[y * w + x + 1] { seen[y * w + x + 1] = true; stack.push((x + 1, y)); }
                if y > 0 && !seen[(y - 1) * w + x] && mask[(y - 1) * w + x] { seen[(y - 1) * w + x] = true; stack.push((x, y - 1)); }
                if y + 1 < h && !seen[(y + 1) * w + x] && mask[(y + 1) * w + x] { seen[(y + 1) * w + x] = true; stack.push((x, y + 1)); }
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

    // Corner detection by farthest-point search. Unlike the old extreme-x±y
    // heuristic (which lands on edge midpoints when the page is near
    // axis-aligned, and on the wrong points when the blob is concave), this is
    // the standard document-scanner approach and is robust to tilt and noise:
    //   c1 = point farthest from the centroid,
    //   c3 = point farthest from c1 (the opposite corner),
    //   c2/c4 = points of greatest perpendicular distance either side of c1–c3.
    let pt = |p: u32| ((p & 0xffff) as f64, (p >> 16) as f64);
    let n = best.len() as f64;
    let (mut sx, mut sy) = (0f64, 0f64);
    for &p in &best { let (x, y) = pt(p); sx += x; sy += y; }
    let (cx, cy) = (sx / n, sy / n);

    let farthest_from = |ax: f64, ay: f64| -> (f64, f64) {
        let mut bestp = (ax, ay);
        let mut bestd = -1.0;
        for &p in &best {
            let (x, y) = pt(p);
            let d = (x - ax).powi(2) + (y - ay).powi(2);
            if d > bestd { bestd = d; bestp = (x, y); }
        }
        bestp
    };
    let (c1x, c1y) = farthest_from(cx, cy);
    let (c3x, c3y) = farthest_from(c1x, c1y);

    // Signed perpendicular distance of each point from the c1→c3 line.
    let (dx, dy) = (c3x - c1x, c3y - c1y);
    let (mut c2, mut c4) = ((c1x, c1y), (c1x, c1y));
    let (mut max_pos, mut max_neg) = (0f64, 0f64);
    for &p in &best {
        let (x, y) = pt(p);
        let cross = dx * (y - c1y) - dy * (x - c1x);
        if cross > max_pos { max_pos = cross; c2 = (x, y); }
        if cross < max_neg { max_neg = cross; c4 = (x, y); }
    }

    let quad = order_quad([(c1x, c1y), c2, (c3x, c3y), c4]);

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

/// Morphological close (dilate then erode, 3×3 / radius 1). Out-of-bounds
/// neighbours count as "set" during erosion so a page touching the frame edge
/// isn't eaten away.
fn morph_close(mask: &[bool], w: usize, h: usize) -> Vec<bool> {
    let mut dil = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut v = false;
            'd: for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 && mask[ny as usize * w + nx as usize] {
                        v = true;
                        break 'd;
                    }
                }
            }
            dil[y * w + x] = v;
        }
    }
    let mut er = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut v = true;
            'e: for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 && !dil[ny as usize * w + nx as usize] {
                        v = false;
                        break 'e;
                    }
                }
            }
            er[y * w + x] = v;
        }
    }
    er
}

/// Order four points as TL, TR, BR, BL. Sorts clockwise by angle about the
/// centroid (image y points down, so increasing atan2 is clockwise), then
/// rotates the cycle to start at the top-left-most point (min x+y).
fn order_quad(p: [(f64, f64); 4]) -> [(f64, f64); 4] {
    let cx = (p[0].0 + p[1].0 + p[2].0 + p[3].0) / 4.0;
    let cy = (p[0].1 + p[1].1 + p[2].1 + p[3].1) / 4.0;
    let mut s = p;
    s.sort_by(|a, b| (a.1 - cy).atan2(a.0 - cx).partial_cmp(&(b.1 - cy).atan2(b.0 - cx)).unwrap());
    let mut start = 0;
    let mut best = f64::MAX;
    for (i, q) in s.iter().enumerate() {
        if q.0 + q.1 < best { best = q.0 + q.1; start = i; }
    }
    [s[start], s[(start + 1) % 4], s[(start + 2) % 4], s[(start + 3) % 4]]
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
