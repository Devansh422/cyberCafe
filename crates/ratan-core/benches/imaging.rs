//! Criterion benchmarks for the imaging pipeline.
//!
//! Run with:
//!   cargo bench -p ratan-core
//!
//! Results land in target/criterion/imaging/. Open
//! target/criterion/report/index.html after two runs to see regression charts.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use image::{RgbImage, Rgb};
use ratan_core::imaging::{apply_preset_pixels, preset, render_image_to_a4_pdf};

// Synthetic 2 MP JPEG — representative of a photo taken on a budget phone.
// We encode it fresh each bench run so the benchmark stays self-contained;
// the cost of encoding is amortized over many iterations.
fn make_jpeg_bytes(w: u32, h: u32) -> Vec<u8> {
    let img = RgbImage::from_fn(w, h, |x, y| {
        Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
    });
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .unwrap();
    buf.into_inner()
}

fn bench_preset_pixels(c: &mut Criterion) {
    // 600×800 canvas — typical collage cell size after contain-fit.
    let canvas = RgbImage::from_pixel(600, 800, Rgb([200, 195, 190]));
    let p_high = preset("high_contrast").unwrap();
    let p_bw   = preset("bw").unwrap();
    let p_scan = preset("scan_pdf").unwrap();

    let mut g = c.benchmark_group("apply_preset_pixels 600×800");
    g.bench_function("high_contrast (grayscale+contrast+sharpen+threshold)", |b| {
        b.iter(|| apply_preset_pixels(black_box(canvas.clone()), black_box(&p_high)))
    });
    g.bench_function("bw (grayscale only)", |b| {
        b.iter(|| apply_preset_pixels(black_box(canvas.clone()), black_box(&p_bw)))
    });
    g.bench_function("scan_pdf (grayscale+brightness+contrast+sharpen)", |b| {
        b.iter(|| apply_preset_pixels(black_box(canvas.clone()), black_box(&p_scan)))
    });
    g.finish();
}

fn bench_render_to_a4(c: &mut Criterion) {
    // 1600×1200 ≈ 2 MP; keep it small so the bench suite runs in reasonable time
    // on the CI runner, while still exercising the CatmullRom downscale path.
    let bytes = make_jpeg_bytes(1600, 1200);
    let p_high = preset("high_contrast").unwrap();
    let p_color = preset("color").unwrap();

    let mut g = c.benchmark_group("render_image_to_a4_pdf 1600×1200");
    g.sample_size(10); // PDF encode is slow; 10 samples give sufficient CI.
    g.bench_function("high_contrast", |b| {
        b.iter(|| render_image_to_a4_pdf(black_box(&bytes), black_box(&p_high)).unwrap())
    });
    g.bench_function("color", |b| {
        b.iter(|| render_image_to_a4_pdf(black_box(&bytes), black_box(&p_color)).unwrap())
    });
    g.finish();
}

criterion_group!(benches, bench_preset_pixels, bench_render_to_a4);
criterion_main!(benches);
