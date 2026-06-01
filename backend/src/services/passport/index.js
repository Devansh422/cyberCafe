// Passport-photo pipeline.
//
//   input photo
//     ──▶ MODNet matte (background removal) ──▶ composite over a solid colour
//     ──▶ UltraFace face detection ──▶ centre on the face, crop to 3:4 with
//         passport headroom ──▶ resize to high-res
//     ──▶ tile 3×3 on a 4"×6" sheet ──▶ PDF.
//
// Both models run natively in Node via onnxruntime-node:
//   • MODNet  (./MODNet/pretrained/modnet.onnx) — matting; preprocessing mirrors
//     onnx/inference_onnx.py (ref_size 512, [-1,1] norm, NCHW).
//   • UltraFace RFB-320 (./models/ultraface-RFB-320.onnx) — face detection;
//     input 320×240, (x-127)/128 norm, outputs decoded boxes + scores.
// Each degrades gracefully if its model/onnxruntime is missing: matting is
// skipped (matted:false) and/or the crop falls back to a centred frame
// (faceDetected:false) so the UI can warn the operator.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const config = require('../../lib/config');
const media = require('../media');
const jobsDb = require('../../db/jobs');
const activity = require('../../db/activity');

let sharp = null;
let PDFDocument = null;
let ort = null;
try { sharp = require('sharp'); } catch { /* installed lazily */ }
try { ({ PDFDocument } = require('pdf-lib')); } catch { /* installed lazily */ }
try { ort = require('onnxruntime-node'); } catch { /* optional — graceful fallback */ }

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ---- Geometry (the print spec) ---------------------------------------------
// 4"×6" paper, portrait. 3 photos per row × 3 rows = 9. Photos are portrait at a
// 3:4 aspect (w:h = 3:4, taller than wide — the standard passport shape), sized
// to fit the WIDTH; rows stack from the top and whatever space is left at the
// bottom stays blank.
const SHEET = {
  dpi: 300,
  wIn: 4,
  hIn: 6,
  cols: 3,
  rows: 3,
  marginIn: 0.12,
  gapIn: 0.08,
  photoAspect: 3 / 4, // width / height (portrait)
};

const REF_SIZE = 512; // MODNet reference input size
const COMPOSITE_MAX = 1500; // cap working resolution for matting/compositing
const FACE_W = 320; // UltraFace RFB-320 input width
const FACE_H = 240; // UltraFace RFB-320 input height
const FACE_SCORE_MIN = 0.6; // confidence threshold for a face
const SUBJECT_MIN = 0.12; // min mean matte coverage to treat the photo as having a real subject
const OUT_W = 900; // prepared photo width  (3:4)
const OUT_H = 1200; // prepared photo height (3:4) — high-res, sheet downscales

// ---- Passport crop geometry (tuned to standard ID-photo proportions) -------
// UltraFace's box hugs the face (≈ brow → chin) and misses the crown/hair, so
// we scale it up to a full head, then frame that head to fill ~62% of the photo
// with the eye-line ~40% down — the band most passport specs ask for.
const HEAD_FROM_FACE = 1.5; // full head height (crown→chin) ≈ 1.5× the face box
const HEAD_RATIO = 0.62; // head height as a fraction of the photo height
const EYE_FROM_TOP = 0.40; // eye-line position, measured from the top of the crop
const EYE_IN_FACE = 0.40; // eyes sit ≈ 40% down inside the detector's face box
// Matte edge shaping: harden faint background haze toward 0 and solid subject
// toward 1 (kills the colour fringe), keeping a soft transition for clean hair.
const MATTE_GAIN = 1.35; // contrast applied around the mid-point
const MATTE_PIVOT = 0.5;

// Background presets the UI can pick from (hex). "light blue" is the default.
const BG_PRESETS = {
  'light-blue': '#c9ddee',
  white: '#ffffff',
  'light-grey': '#e9ecef',
  red: '#d23b3b',
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return { r: 201, g: 221, b: 238 }; // light blue fallback
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function resolveBg(bg) {
  if (!bg) return hexToRgb(BG_PRESETS['light-blue']);
  if (BG_PRESETS[bg]) return hexToRgb(BG_PRESETS[bg]);
  return hexToRgb(bg);
}

// Where prepared (background-removed) photos live before they're tiled.
function preparedDir() {
  return path.join(config.mediaRoot, config.folders.temp, 'passport');
}
function preparedPath(id) {
  return path.join(preparedDir(), `${id}.png`);
}

// ---- MODNet model discovery + session cache --------------------------------
function findModel() {
  const candidates = [
    process.env.MODNET_ONNX,
    path.join(PROJECT_ROOT, 'MODNet', 'pretrained', 'modnet.onnx'),
    path.join(PROJECT_ROOT, 'MODNet', 'pretrained', 'modnet_photographic_portrait_matting.onnx'),
    path.join(PROJECT_ROOT, 'MODNet', 'onnx', 'modnet.onnx'),
    path.join(PROJECT_ROOT, 'MODNet', 'modnet.onnx'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

let _sessionPromise = null;
function getSession() {
  if (!ort) return Promise.resolve(null);
  const model = findModel();
  if (!model) return Promise.resolve(null);
  if (!_sessionPromise) {
    _sessionPromise = ort.InferenceSession.create(model).catch((err) => {
      console.error('[passport] failed to load MODNet model:', err.message);
      _sessionPromise = null; // allow a later retry
      return null;
    });
  }
  return _sessionPromise;
}

// ---- Face-detector discovery + session cache -------------------------------
function findFaceModel() {
  const candidates = [
    process.env.FACE_ONNX,
    path.join(PROJECT_ROOT, 'models', 'ultraface-RFB-320.onnx'),
    path.join(PROJECT_ROOT, 'models', 'version-RFB-320.onnx'),
    path.join(PROJECT_ROOT, 'MODNet', 'pretrained', 'ultraface-RFB-320.onnx'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

let _faceSessionPromise = null;
function getFaceSession() {
  if (!ort) return Promise.resolve(null);
  const model = findFaceModel();
  if (!model) return Promise.resolve(null);
  if (!_faceSessionPromise) {
    _faceSessionPromise = ort.InferenceSession.create(model).catch((err) => {
      console.error('[passport] failed to load face model:', err.message);
      _faceSessionPromise = null;
      return null;
    });
  }
  return _faceSessionPromise;
}

function status() {
  const model = findModel();
  const faceModel = findFaceModel();
  return {
    ortLoaded: !!ort,
    modelFound: !!model,
    modelPath: model ? path.relative(PROJECT_ROOT, model) : null,
    ready: !!ort && !!model,
    faceModelFound: !!faceModel,
    faceReady: !!ort && !!faceModel,
    bgPresets: Object.keys(BG_PRESETS),
  };
}

// Replicates MODNet's get_scale_factor: target dims near REF_SIZE, snapped to
// multiples of 32.
function modelDims(imH, imW) {
  let rh;
  let rw;
  if (Math.max(imH, imW) < REF_SIZE || Math.min(imH, imW) > REF_SIZE) {
    if (imW >= imH) {
      rh = REF_SIZE;
      rw = Math.round((imW / imH) * REF_SIZE);
    } else {
      rw = REF_SIZE;
      rh = Math.round((imH / imW) * REF_SIZE);
    }
  } else {
    rh = imH;
    rw = imW;
  }
  rw -= rw % 32;
  rh -= rh % 32;
  return { rw: Math.max(32, rw), rh: Math.max(32, rh) };
}

// Run MODNet and composite the subject over `bg`. Returns RAW RGB buffers (so a
// face-aware crop can follow without re-decoding): the composited image, the
// original foreground (used for face detection), the working dims, and whether
// matting actually happened.
async function matteComposite(inputBuffer, bg) {
  if (!sharp) throw new Error('sharp unavailable — run npm install in /backend');
  const bgRgb = resolveBg(bg);

  // Work at a capped resolution: good matte quality, fast compositing.
  const { data: fg, info } = await sharp(inputBuffer)
    .rotate()
    .resize(COMPOSITE_MAX, COMPOSITE_MAX, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cw = info.width;
  const ch = info.height;

  const session = await getSession();
  if (!session) {
    // No model/runtime → no removal; the composite is just the photo as-is.
    return { composited: fg, fg, cw, ch, matted: false, subjectFound: null, coverage: null };
  }

  // Build the model input (NCHW, normalised to [-1, 1]).
  const { rw, rh } = modelDims(ch, cw);
  const modelRaw = await sharp(fg, { raw: { width: cw, height: ch, channels: 3 } })
    .resize(rw, rh, { fit: 'fill' })
    .raw()
    .toBuffer();

  const chw = new Float32Array(3 * rh * rw);
  const plane = rh * rw;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const src = (y * rw + x) * 3;
      const dst = y * rw + x;
      chw[dst] = (modelRaw[src] - 127.5) / 127.5; // R
      chw[plane + dst] = (modelRaw[src + 1] - 127.5) / 127.5; // G
      chw[2 * plane + dst] = (modelRaw[src + 2] - 127.5) / 127.5; // B
    }
  }

  const tensor = new ort.Tensor('float32', chw, [1, 3, rh, rw]);
  const results = await session.run({ [session.inputNames[0]]: tensor });
  const matte = results[session.outputNames[0]].data; // Float32Array rh*rw, 0..1

  // How much of the frame is foreground? If almost nothing, this photo has no
  // clear subject (a meme, logo, scene…). Removing the "background" then would
  // just paint the whole frame the bg colour — confusing. Keep the original.
  let msum = 0;
  for (let i = 0; i < matte.length; i++) {
    const v = matte[i] < 0 ? 0 : matte[i] > 1 ? 1 : matte[i];
    msum += v;
  }
  const coverage = msum / matte.length;
  if (coverage < SUBJECT_MIN) {
    return { composited: fg, fg, cw, ch, matted: false, subjectFound: false, coverage };
  }

  // Shape the matte before upscaling: a contrast curve around the mid-point
  // pushes faint background haze to 0 (no colour fringe) and solid subject to 1,
  // while leaving genuine soft edges (hair) in between.
  const matte8 = Buffer.allocUnsafe(rh * rw);
  for (let i = 0; i < matte.length; i++) {
    let v = (matte[i] - MATTE_PIVOT) * MATTE_GAIN + MATTE_PIVOT;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    matte8[i] = Math.round(v * 255);
  }
  // Upscale the matte back to the working resolution, with a sub-pixel blur to
  // feather the edge (anti-aliased cut). Force a single-channel ('b-w') output:
  // sharp otherwise promotes a 1-channel raw input back to 3-channel sRGB on
  // `.raw()`, so `matteFull` would be 3 bytes/pixel while the composite below
  // indexes it as 1 — scrambling the alpha (subject erased, horizontal
  // striping). We still read the real stride back and index by it so the maths
  // is correct regardless of how many channels sharp returns.
  const { data: matteFull, info: matteInfo } = await sharp(matte8, { raw: { width: rw, height: rh, channels: 1 } })
    .resize(cw, ch, { fit: 'fill' })
    .blur(0.5)
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mch = matteInfo.channels; // expected 1

  // Composite: out = fg*alpha + bg*(1-alpha).
  const out = Buffer.allocUnsafe(cw * ch * 3);
  for (let i = 0; i < cw * ch; i++) {
    const a = matteFull[i * mch] / 255;
    const ia = 1 - a;
    const s = i * 3;
    out[s] = Math.round(fg[s] * a + bgRgb.r * ia);
    out[s + 1] = Math.round(fg[s + 1] * a + bgRgb.g * ia);
    out[s + 2] = Math.round(fg[s + 2] * a + bgRgb.b * ia);
  }

  return { composited: out, fg, cw, ch, matted: true, subjectFound: true, coverage };
}

// Detect the most confident face in a raw RGB image. Returns a pixel-space box
// { x1, y1, x2, y2 } or null (no model / no confident face). UltraFace outputs
// already-decoded boxes (normalised corners) + per-class scores.
async function detectFace(fgRaw, cw, ch) {
  const session = await getFaceSession();
  if (!session) return null;

  const resized = await sharp(fgRaw, { raw: { width: cw, height: ch, channels: 3 } })
    .resize(FACE_W, FACE_H, { fit: 'fill' })
    .raw()
    .toBuffer();

  const data = new Float32Array(3 * FACE_H * FACE_W);
  const plane = FACE_H * FACE_W;
  for (let y = 0; y < FACE_H; y++) {
    for (let x = 0; x < FACE_W; x++) {
      const s = (y * FACE_W + x) * 3;
      const d = y * FACE_W + x;
      data[d] = (resized[s] - 127) / 128;
      data[plane + d] = (resized[s + 1] - 127) / 128;
      data[2 * plane + d] = (resized[s + 2] - 127) / 128;
    }
  }

  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, FACE_H, FACE_W]) });
  let scores;
  let boxes;
  for (const name of session.outputNames) {
    const t = out[name];
    if (t.dims[t.dims.length - 1] === 2) scores = t;
    else if (t.dims[t.dims.length - 1] === 4) boxes = t;
  }
  if (!scores || !boxes) return null;

  // Collect every confident detection, then pick the dominant face. A passport
  // photo has one subject; choosing the LARGEST box (tie-broken by score) is far
  // more robust than raw max-score, which a tiny high-confidence background
  // false-positive could otherwise win.
  const n = scores.dims[1];
  const b = boxes.data;
  const cand = [];
  for (let i = 0; i < n; i++) {
    const sc = scores.data[i * 2 + 1]; // [bg, face]
    if (sc < FACE_SCORE_MIN) continue;
    const x1 = Math.max(0, Math.min(cw, b[i * 4] * cw));
    const y1 = Math.max(0, Math.min(ch, b[i * 4 + 1] * ch));
    const x2 = Math.max(0, Math.min(cw, b[i * 4 + 2] * cw));
    const y2 = Math.max(0, Math.min(ch, b[i * 4 + 3] * ch));
    const w = x2 - x1;
    const h = y2 - y1;
    if (w < 8 || h < 8) continue;
    cand.push({ x1, y1, x2, y2, score: sc, area: w * h });
  }
  if (!cand.length) return null;
  cand.sort((p, q) => (q.area - p.area) || (q.score - p.score));
  return cand[0];
}

// Clamp a {left,top,width,height} rect fully inside the image.
function clampRect(r, W, H) {
  let { left, top, width, height } = r;
  width = Math.min(width, W);
  height = Math.min(height, H);
  left = Math.max(0, Math.min(left, W - width));
  top = Math.max(0, Math.min(top, H - height));
  return { left: Math.round(left), top: Math.round(top), width: Math.floor(width), height: Math.floor(height) };
}

// Given a detected face box, produce a 3:4 passport crop: the face centred
// horizontally, the head filling ~62% of the frame, and the eye-line ~40% down
// — standard ID-photo proportions. Scales down to fit when the ideal frame
// exceeds the image bounds.
function passportCrop(W, H, box) {
  const fh = box.y2 - box.y1;
  const cx = (box.x1 + box.x2) / 2;
  const headH = fh * HEAD_FROM_FACE; // crown→chin, larger than the detector box
  let cropH = headH / HEAD_RATIO; // head occupies HEAD_RATIO of the photo height
  let cropW = cropH * SHEET.photoAspect; // 3:4 (w = h * 0.75)
  const scale = Math.min(1, W / cropW, H / cropH);
  cropH *= scale;
  cropW *= scale;
  // Anchor on the eye-line: ~40% down inside the face box, placed EYE_FROM_TOP
  // down the crop so there's proper headroom above and shoulders below.
  const eyeY = box.y1 + EYE_IN_FACE * fh;
  const left = cx - cropW / 2;
  const top = eyeY - EYE_FROM_TOP * cropH;
  return clampRect({ left, top, width: cropW, height: cropH }, W, H);
}

// No face found → largest centred 3:4 frame, anchored slightly above centre.
function fallbackCrop(W, H) {
  let cropW = W;
  let cropH = cropW / SHEET.photoAspect;
  if (cropH > H) { cropH = H; cropW = cropH * SHEET.photoAspect; }
  const left = (W - cropW) / 2;
  const top = Math.min(H - cropH, H * 0.04);
  return clampRect({ left, top, width: cropW, height: cropH }, W, H);
}

// Prepare one photo: remove background, detect + centre the face, crop to 3:4
// at high resolution, save it, and return a handle the UI can preview and tile.
async function prepare(inputBuffer, { bg } = {}) {
  await fsp.mkdir(preparedDir(), { recursive: true });
  const { composited, fg, cw, ch, matted, subjectFound } = await matteComposite(inputBuffer, bg);

  let face = null;
  try {
    face = await detectFace(fg, cw, ch);
  } catch (err) {
    console.error('[passport] face detection error:', err.message);
  }
  const rect = face ? passportCrop(cw, ch, face) : fallbackCrop(cw, ch);

  const buffer = await sharp(composited, { raw: { width: cw, height: ch, channels: 3 } })
    .extract(rect)
    .resize(OUT_W, OUT_H, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
    .png()
    .toBuffer();

  const id = crypto.randomUUID();
  await fsp.writeFile(preparedPath(id), buffer);
  activity.log(null, 'passport_prepared', `Photo prepared (matted=${matted}, subject=${subjectFound}, face=${!!face})`);
  return { id, matted, subjectFound, faceDetected: !!face, bg: bg || 'light-blue' };
}

// Prepare a passport photo from an existing job — typically a WhatsApp incoming
// image. Reads the job's original (un-rendered) image file off disk.
async function prepareFromJob(jobId, { bg } = {}) {
  const job = jobsDb.getJob(jobId);
  if (!job) throw new Error('job not found');
  if (job.type !== 'image') throw new Error('passport photos must be images (jpg/png)');
  const src = media.absolutePath(job.storage_folder, job.filename);
  if (!fs.existsSync(src)) throw new Error('source image file missing');
  const buffer = await fsp.readFile(src);
  const res = await prepare(buffer, { bg });
  return { ...res, jobId, label: job.original_name || job.filename, customer: job.customer_name || job.customer_phone || null };
}

// ---- Sheet builder ----------------------------------------------------------
function cellLayout() {
  const { dpi, wIn, hIn, cols, rows, marginIn, gapIn, photoAspect } = SHEET;
  const sheetW = Math.round(wIn * dpi);
  const sheetH = Math.round(hIn * dpi);
  const margin = Math.round(marginIn * dpi);
  const gap = Math.round(gapIn * dpi);
  const cellW = Math.floor((sheetW - 2 * margin - (cols - 1) * gap) / cols);
  const cellH = Math.round(cellW / photoAspect); // 3:4 portrait → height = width * 4/3
  const slots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({
        left: margin + c * (cellW + gap),
        top: margin + r * (cellH + gap),
      });
    }
  }
  return { sheetW, sheetH, margin, gap, cellW, cellH, slots, max: cols * rows };
}

// Build a sheet from an ordered list of prepared photo ids (already repeated
// per the requested copies). Tiles up to 9, row-major, blank space at bottom.
async function buildSheet(orderedIds) {
  if (!sharp || !PDFDocument) throw new Error('sharp/pdf-lib unavailable — run npm install in /backend');
  const ids = orderedIds.slice(0, SHEET.cols * SHEET.rows);
  if (!ids.length) throw new Error('no photos selected');

  const L = cellLayout();

  const composites = [];
  for (let i = 0; i < ids.length; i++) {
    const file = preparedPath(ids[i]);
    if (!fs.existsSync(file)) continue;
    // Prepared photos are already face-centred 3:4; just scale to the cell.
    const cell = await sharp(file)
      .resize(L.cellW, L.cellH, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
      .png()
      .toBuffer();
    composites.push({ input: cell, left: L.slots[i].left, top: L.slots[i].top });
  }
  if (!composites.length) throw new Error('prepared photos missing — re-add them');

  const sheetPng = await sharp({
    create: { width: L.sheetW, height: L.sheetH, channels: 3, background: '#ffffff' },
  })
    .composite(composites)
    .png()
    .toBuffer();

  // Wrap the raster sheet in a 4"×6" PDF and add thin cut guides per photo.
  const pdf = await PDFDocument.create();
  const pageW = SHEET.wIn * 72;
  const pageH = SHEET.hIn * 72;
  const page = pdf.addPage([pageW, pageH]);
  const png = await pdf.embedPng(sheetPng);
  page.drawImage(png, { x: 0, y: 0, width: pageW, height: pageH });

  const guide = require('pdf-lib').rgb(0.78, 0.78, 0.78);
  for (let i = 0; i < composites.length; i++) {
    const s = L.slots[i];
    const x = (s.left / L.sheetW) * pageW;
    const w = (L.cellW / L.sheetW) * pageW;
    const h = (L.cellH / L.sheetH) * pageH;
    // PDF y-origin is bottom-left; flip from the top-based pixel coords.
    const y = pageH - (s.top / L.sheetH) * pageH - h;
    page.drawRectangle({ x, y, width: w, height: h, borderColor: guide, borderWidth: 0.5 });
  }

  return Buffer.from(await pdf.save());
}

// Expand [{id, copies}] into a row-major id list (capped at 9), build the sheet,
// then register it as a processed job so it prints like anything else.
async function createSheet(items, { bg } = {}) {
  const ordered = [];
  for (const it of items || []) {
    const copies = Math.max(1, Math.min(9, parseInt(it.copies, 10) || 1));
    for (let i = 0; i < copies; i++) ordered.push(it.id);
  }
  if (!ordered.length) throw new Error('add at least one photo');

  const pdfBytes = await buildSheet(ordered);

  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const count = Math.min(ordered.length, SHEET.cols * SHEET.rows);
  const destName = `passport_${ts}_${count}up.pdf`;
  const destDir = path.join(config.mediaRoot, config.folders.processed);
  await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, destName);
  await fsp.writeFile(dest, pdfBytes);

  const created = jobsDb.createJob({
    filename: destName,
    original_name: `Passport sheet · ${count} photo${count === 1 ? '' : 's'}`,
    type: 'pdf',
    mime_type: 'application/pdf',
    size: pdfBytes.length,
    customer_name: 'Passport',
    status: 'processed',
    source: 'passport',
    storage_folder: config.folders.processed,
  });
  const job = jobsDb.updateJob(created.id, { processed_path: dest, preset: 'passport', pages: 1 });
  activity.log(job.id, 'passport_sheet', `Passport sheet ${destName} (${count} up, bg=${bg || 'light-blue'})`);
  return job;
}

module.exports = {
  status,
  prepare,
  prepareFromJob,
  preparedPath,
  createSheet,
  cellLayout,
  BG_PRESETS,
  // exported for diagnostics/tests
  matteComposite,
  detectFace,
  passportCrop,
  fallbackCrop,
};
