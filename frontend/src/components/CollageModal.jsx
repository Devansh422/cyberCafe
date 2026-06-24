'use client';
import { useEffect, useRef, useState } from 'react';
import { X, Check, Images, RotateCcw, RotateCw, FlipHorizontal2, FlipVertical2, ImageIcon, Crosshair } from 'lucide-react';
import { api, fileUrl } from '@/lib/api';
import { Avatar } from './Avatar';
import { Spinner } from './Spinner';

// Detect the ID card bounding box using Sobel gradient edge projection.
// A box blur first suppresses fine background texture (fabric patterns, wallpaper)
// so only large-scale card edges remain. Gx column projection finds left/right
// boundaries; Gy row projection finds top/bottom boundaries. Works regardless of
// background color/pattern — the old corner-sampling approach broke on patterned
// or multi-colored backgrounds like fabric, printed sheets, etc.
// Returns { imgW, imgH, bounds:{x,y,w,h} } (0–1 normalized).
async function detectIdBounds(imgSrc) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const { naturalWidth: imgW, naturalHeight: imgH } = img;
      const MAX = 600;
      const sx = Math.min(1, MAX / Math.max(imgW, imgH));
      const W = Math.max(1, Math.round(imgW * sx));
      const H = Math.max(1, Math.round(imgH * sx));
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, W, H);
      const { data } = ctx.getImageData(0, 0, W, H);

      // BT.601 luma
      const gray = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++)
        gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;

      // Box blur: radius ≈ 2% of smaller dimension (min 3 px).
      // Kills fine background texture while preserving the card's large-scale boundary.
      const r = Math.max(3, Math.round(Math.min(W, H) * 0.02));
      const bl = idBoxBlur(gray, W, H, r);

      // Sobel: Gx detects vertical edges (left/right card boundary);
      //        Gy detects horizontal edges (top/bottom card boundary).
      const agx = new Float32Array(W * H);
      const agy = new Float32Array(W * H);
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const gx =
            -bl[(y-1)*W+x-1] + bl[(y-1)*W+x+1]
            - 2*bl[y*W+x-1]  + 2*bl[y*W+x+1]
            - bl[(y+1)*W+x-1] + bl[(y+1)*W+x+1];
          const gy =
            -bl[(y-1)*W+x-1] - 2*bl[(y-1)*W+x] - bl[(y-1)*W+x+1]
            + bl[(y+1)*W+x-1] + 2*bl[(y+1)*W+x] + bl[(y+1)*W+x+1];
          agx[y*W+x] = Math.abs(gx);
          agy[y*W+x] = Math.abs(gy);
        }
      }

      // Projection profiles: the card boundary spans many rows/columns so it
      // produces the dominant peak even against a textured background.
      const colProj = new Float32Array(W); // sum |Gx| per column → vertical edges
      const rowProj = new Float32Array(H); // sum |Gy| per row    → horizontal edges
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          colProj[x] += agx[y*W+x];
          rowProj[y] += agy[y*W+x];
        }

      const SC = idSmooth1D(colProj, 3);
      const SR = idSmooth1D(rowProj, 3);

      // Outer 4% of each dimension may contain hard image-border artefacts — skip them.
      const mx = Math.round(W * 0.04);
      const my = Math.round(H * 0.04);
      const left   = idOuterPeak(SC, mx,     Math.floor(W / 2), +1);
      const right  = idOuterPeak(SC, W-1-mx, Math.ceil(W / 2),  -1);
      const top    = idOuterPeak(SR, my,     Math.floor(H / 2), +1);
      const bottom = idOuterPeak(SR, H-1-my, Math.ceil(H / 2),  -1);

      if (right <= left || bottom <= top) { resolve({ imgW, imgH, bounds: null }); return; }
      resolve({
        imgW, imgH,
        bounds: {
          x: left / W,
          y: top / H,
          w: Math.max(0.1, (right - left) / W),
          h: Math.max(0.1, (bottom - top) / H),
        },
      });
    };
    img.onerror = () => resolve({ imgW: 0, imgH: 0, bounds: null });
    img.src = imgSrc;
  });
}

function idBoxBlur(src, W, H, r) {
  const tmp = new Uint8Array(W * H);
  const dst = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let d = -r; d <= r; d++) { const xi = x+d; if (xi >= 0 && xi < W) { s += src[y*W+xi]; n++; } }
      tmp[y*W+x] = (s / n + 0.5) | 0;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let d = -r; d <= r; d++) { const yi = y+d; if (yi >= 0 && yi < H) { s += tmp[yi*W+x]; n++; } }
      dst[y*W+x] = (s / n + 0.5) | 0;
    }
  return dst;
}

function idSmooth1D(arr, r) {
  const n = arr.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, cnt = 0;
    for (let d = -r; d <= r; d++) { const j = i+d; if (j >= 0 && j < n) { s += arr[j]; cnt++; } }
    out[i] = s / cnt;
  }
  return out;
}

// Scan from `start` toward `end` (direction ±1); return the first index where
// the profile exceeds 30% of the maximum in [start,end] — the leading edge of
// the dominant gradient peak, i.e. where the card boundary begins.
function idOuterPeak(profile, start, end, dir) {
  const lo = Math.min(start, end), hi = Math.max(start, end);
  let maxVal = 0, maxIdx = lo;
  for (let i = lo; i <= hi; i++) if (profile[i] > maxVal) { maxVal = profile[i]; maxIdx = i; }
  const thresh = maxVal * 0.30;
  for (let i = start; dir > 0 ? i <= maxIdx : i >= maxIdx; i += dir)
    if (profile[i] >= thresh) return i;
  return maxIdx;
}

// Cell rectangles as page fractions [x, y, w, h] (top-down). Both photos live
// in the TOP HALF of the A4 page — the bottom half stays blank. MUST stay in
// sync with `collage_cells` in crates/ratan-core/src/processing.rs so the live
// preview matches the generated PDF.
const COLLAGE_CELLS = {
  vertical: [[0.06, 0.045, 0.88, 0.205], [0.06, 0.275, 0.88, 0.205]],
  horizontal: [[0.05, 0.045, 0.43, 0.435], [0.52, 0.045, 0.43, 0.435]],
};

const DEFAULT_TF = { zoom: 1, panX: 0, panY: 0, rotation: 0, flipH: false, flipV: false };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Tiny inline glyphs for the layout toggle — both variants sit in the top half
// of the page, mirroring the real A4 placement.
function LayoutGlyph({ kind }) {
  return kind === 'vertical' ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="2" y="1.5" width="12" height="2.8" rx="0.8" />
      <rect x="2" y="5.3" width="12" height="2.8" rx="0.8" />
      <rect x="2" y="9.5" width="12" height="5" rx="0.8" opacity="0.15" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="2" y="1.5" width="5.6" height="6.6" rx="0.8" />
      <rect x="8.4" y="1.5" width="5.6" height="6.6" rx="0.8" />
      <rect x="2" y="9.5" width="12" height="5" rx="0.8" opacity="0.15" />
    </svg>
  );
}

// One photo placed inside its A4 cell. translate is in % of the element (which
// fills the cell), so panX/panY of ±1 shifts by half a cell — matching the
// server's `pan * (cell/2)`. object-fit:contain gives the same baseline scale.
function CollageCell({ rect, id, tf, onPan, guides, cellRef }) {
  const [fx, fy, fw, fh] = rect;
  const drag = useRef(null);

  function down(e) {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, panX: tf.panX, panY: tf.panY, w: r.width, h: r.height };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }
  function move(e) {
    const d = drag.current;
    if (!d) return;
    onPan(
      clamp(d.panX + (e.clientX - d.x) / (d.w / 2), -1.5, 1.5),
      clamp(d.panY + (e.clientY - d.y) / (d.h / 2), -1.5, 1.5),
    );
  }
  function up(e) {
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  }

  return (
    <div
      ref={cellRef}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      style={{
        position: 'absolute',
        left: `${fx * 100}%`,
        top: `${fy * 100}%`,
        width: `${fw * 100}%`,
        height: `${fh * 100}%`,
        overflow: 'hidden',
        background: 'var(--color-bg-overlay)',
        border: guides ? '1px dashed var(--color-border)' : '1px dashed transparent',
        cursor: 'grab',
        touchAction: 'none',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={fileUrl(id)}
        alt=""
        draggable={false}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          // Keep this pipeline in sync with `compose_collage` in
          // processing.rs: rotate, then flip (negative scale), then pan.
          transform: `translate(${tf.panX * 50}%, ${tf.panY * 50}%) scale(${tf.flipH ? -tf.zoom : tf.zoom}, ${tf.flipV ? -tf.zoom : tf.zoom}) rotate(${tf.rotation}deg)`,
          transformOrigin: 'center',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      />
    </div>
  );
}

// 2-photo collage builder for double-sided ID prints. Phase 1: pick exactly two
// photos. Phase 2: choose horizontal/vertical and drag/zoom each onto an A4
// page. Produces a collage *image* (an incoming job) and opens the process popup
// so the operator can pick a scan preset and print — the ID-print pipeline:
// WhatsApp photos → collage image → scanned PDF → print.
export function CollageModal({ jobs = [], onClose, onCreated }) {
  const photos = jobs.filter((j) => j.type === 'image');
  const [selected, setSelected] = useState([]); // ordered [id, id]
  const [transforms, setTransforms] = useState([{ ...DEFAULT_TF }, { ...DEFAULT_TF }]);
  const [layout, setLayout] = useState('vertical');
  const [guides, setGuides] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState(null);
  const [detectingSlot, setDetectingSlot] = useState(null);
  const cellEl0 = useRef(null);
  const cellEl1 = useRef(null);
  const cellEls = [cellEl0, cellEl1];

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !generating) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, generating]);

  const arranging = selected.length === 2;

  function toggle(id) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return prev;
      return [...prev, id];
    });
    setErr(null);
  }

  function setSlot(slot, patch) {
    setTransforms((prev) => prev.map((t, i) => (i === slot ? { ...t, ...patch } : t)));
  }
  function resetSlot(slot) {
    setTransforms((prev) => prev.map((t, i) => (i === slot ? { ...DEFAULT_TF } : t)));
  }

  function back() {
    setSelected([]);
    setTransforms([{ ...DEFAULT_TF }, { ...DEFAULT_TF }]);
    setErr(null);
  }

  // Detect the ID card boundaries in the image and auto-fit zoom + pan to fill the cell.
  async function autoFit(slotIndex) {
    const id = selected[slotIndex];
    if (!id || detectingSlot !== null) return;
    setDetectingSlot(slotIndex);
    try {
      const { imgW, imgH, bounds } = await detectIdBounds(fileUrl(id));
      if (!bounds || !imgW || !imgH) return;
      const cellEl = cellEls[slotIndex].current;
      if (!cellEl) return;
      const { width: cellW, height: cellH } = cellEl.getBoundingClientRect();
      if (!cellW || !cellH) return;
      // objectFit:contain scale
      const S = Math.min(cellW / imgW, cellH / imgH);
      const bCx = bounds.x + bounds.w / 2;
      const bCy = bounds.y + bounds.h / 2;
      // Pan units: translate(panX*50%, panY*50%) on the 100%×100% img element
      const panX = -2 * (bCx - 0.5) * (imgW * S / cellW);
      const panY = -2 * (bCy - 0.5) * (imgH * S / cellH);
      // Zoom to fill cell with detected card bounds, 8% breathing room
      const zoom = Math.min(cellW / (bounds.w * imgW * S), cellH / (bounds.h * imgH * S)) * 0.92;
      setSlot(slotIndex, {
        panX: clamp(panX, -1.5, 1.5),
        panY: clamp(panY, -1.5, 1.5),
        zoom: clamp(zoom, 0.3, 3),
      });
    } finally {
      setDetectingSlot(null);
    }
  }

  async function generate() {
    if (selected.length !== 2 || generating) return;
    setGenerating(true);
    setErr(null);
    try {
      const items = selected.map((id, i) => ({
        id,
        zoom: transforms[i].zoom,
        panX: transforms[i].panX,
        panY: transforms[i].panY,
        rotation: transforms[i].rotation,
        flipH: transforms[i].flipH,
        flipV: transforms[i].flipV,
      }));
      const job = await api.makeCollage(layout, items, guides);
      await onCreated?.(job);
    } catch (e) {
      setErr(e.message || 'Could not create collage');
      setGenerating(false);
    }
  }

  const cells = COLLAGE_CELLS[layout];

  return (
    <div
      onClick={() => { if (!generating) onClose?.(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
        padding: '2vh 2vw',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-enter flex flex-col"
        style={{
          background: 'var(--color-bg-surface)',
          borderRadius: 20,
          width: '90vw',
          height: '90vh',
          boxShadow: '0 24px 80px rgba(0,0,0,0.28)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-3" style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border)' }}>
          <span className="flex items-center justify-center rounded-pill" style={{ width: 32, height: 32, background: 'var(--color-brand)', color: 'var(--color-brand-fg)' }}>
            <Images size={16} />
          </span>
          <div className="flex flex-col min-w-0">
            <h2 className="font-bold" style={{ fontSize: 17 }}>Make collage</h2>
            <span className="text-xs text-text-secondary">
              {arranging ? 'Drag each photo to position it; zoom to fit. Great for both sides of an ID.' : 'Pick exactly 2 photos (e.g. front & back of an ID).'}
            </span>
          </div>
          <button
            onClick={() => { if (!generating) onClose?.(); }}
            aria-label="close"
            className="ml-auto flex items-center justify-center text-text-secondary hover:text-text-primary"
            style={{ width: 34, height: 34, borderRadius: 999, background: 'var(--color-bg-overlay)', border: 'none', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        {!arranging ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, background: 'var(--color-bg-app)' }}>
            {photos.length < 2 ? (
              <div className="flex flex-col items-center justify-center gap-2 text-sm text-text-secondary" style={{ height: '100%' }}>
                <ImageIcon size={28} />
                Need at least 2 photos. Send the front and back as images first.
              </div>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
                {photos.map((job) => {
                  const idx = selected.indexOf(job.id);
                  const sel = idx >= 0;
                  return (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => toggle(job.id)}
                      className="text-left flex flex-col"
                      style={{
                        background: 'var(--color-bg-surface)',
                        borderRadius: 14,
                        border: sel ? '2px solid var(--color-brand)' : '1px solid var(--color-border)',
                        boxShadow: sel ? '0 0 0 3px var(--color-tag-green-bg)' : 'var(--shadow-card)',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        position: 'relative',
                      }}
                    >
                      <span
                        className="flex items-center justify-center rounded-pill"
                        style={{
                          position: 'absolute', top: 8, right: 8, zIndex: 2, width: 24, height: 24,
                          background: sel ? 'var(--color-brand)' : 'rgba(255,255,255,0.85)',
                          color: sel ? 'var(--color-brand-fg)' : 'var(--color-text-secondary)',
                          border: '1px solid var(--color-border)', fontSize: 12, fontWeight: 700,
                        }}
                      >
                        {sel ? (idx + 1) : ''}
                      </span>
                      <div style={{ background: 'var(--color-bg-overlay)', height: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={fileUrl(job.id)} alt={job.filename} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                      </div>
                      <div className="flex items-center gap-2 text-xs text-text-secondary" style={{ padding: '7px 10px' }}>
                        <Avatar name={job.customer_phone || job.customer_name || '?'} size={20} />
                        <span className="text-text-primary font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {job.customer_phone || job.customer_name || 'Unknown'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr', flex: 1, minHeight: 0 }}>
            {/* Preview */}
            <div className="flex items-center justify-center" style={{ padding: 20, background: 'var(--color-bg-app)', minHeight: 0 }}>
              <div
                style={{
                  position: 'relative',
                  height: '100%',
                  maxHeight: '72vh',
                  aspectRatio: '2480 / 3508',
                  background: '#fff',
                  borderRadius: 6,
                  boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
                  overflow: 'hidden',
                }}
              >
                {selected.map((id, i) => (
                  <CollageCell
                    key={id}
                    rect={cells[i]}
                    id={id}
                    tf={transforms[i]}
                    guides={guides}
                    onPan={(panX, panY) => setSlot(i, { panX, panY })}
                    cellRef={cellEls[i]}
                  />
                ))}
                {/* Cut hint between the two cells (both live in the top half) */}
                {guides && (
                  <div
                    style={
                      layout === 'vertical'
                        ? { position: 'absolute', left: '4%', right: '4%', top: '26.25%', borderTop: '1px dashed var(--color-text-muted)' }
                        : { position: 'absolute', top: '3%', height: '46.5%', left: '50%', borderLeft: '1px dashed var(--color-text-muted)' }
                    }
                  />
                )}
              </div>
            </div>

            {/* Controls */}
            <div className="flex flex-col gap-4" style={{ padding: 20, overflowY: 'auto', borderLeft: '1px solid var(--color-border)' }}>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Layout</span>
                <div className="flex gap-2">
                  {['vertical', 'horizontal'].map((k) => {
                    const active = layout === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setLayout(k)}
                        className="flex-1 flex items-center justify-center gap-2 text-sm font-semibold rounded-sm"
                        style={{
                          padding: '10px 12px',
                          textTransform: 'capitalize',
                          background: active ? 'var(--color-brand)' : 'var(--color-bg-overlay)',
                          color: active ? 'var(--color-brand-fg)' : 'var(--color-text-secondary)',
                          border: '1px solid',
                          borderColor: active ? 'var(--color-brand)' : 'var(--color-border)',
                          cursor: 'pointer',
                        }}
                      >
                        <LayoutGlyph kind={k} /> {k}
                      </button>
                    );
                  })}
                </div>
                <label className="flex items-center gap-2 text-xs text-text-secondary select-none" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} />
                  Print dashed cut guides around each photo
                </label>
              </div>

              {selected.map((id, i) => {
                const job = photos.find((j) => j.id === id);
                const tf = transforms[i];
                const toolBtn = (active) => ({
                  padding: '6px 10px',
                  background: active ? 'var(--color-brand)' : 'var(--color-bg-surface)',
                  color: active ? 'var(--color-brand-fg)' : 'var(--color-text-secondary)',
                  border: '1px solid',
                  borderColor: active ? 'var(--color-brand)' : 'var(--color-border)',
                  borderRadius: 8,
                  cursor: 'pointer',
                });
                return (
                  <div key={id} className="flex flex-col gap-2" style={{ background: 'var(--color-bg-overlay)', borderRadius: 12, padding: 12 }}>
                    <div className="flex items-center gap-2">
                      <span className="flex items-center justify-center rounded-pill" style={{ width: 22, height: 22, background: 'var(--color-brand)', color: 'var(--color-brand-fg)', fontSize: 12, fontWeight: 700 }}>
                        {i + 1}
                      </span>
                      <span className="text-sm font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job?.customer_phone || job?.customer_name || job?.original_name || job?.filename || `Photo ${i + 1}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => autoFit(i)}
                        disabled={detectingSlot !== null}
                        title="Auto-detect ID card boundaries and fit to cell"
                        className="ml-auto flex items-center gap-1 text-xs font-semibold"
                        style={{ background: 'none', border: 'none', cursor: detectingSlot !== null ? 'wait' : 'pointer', color: 'var(--color-brand)', flexShrink: 0 }}
                      >
                        {detectingSlot === i ? <Spinner size={12} color="var(--color-brand)" /> : <Crosshair size={12} />} Auto Detect
                      </button>
                      <button
                        type="button"
                        onClick={() => resetSlot(i)}
                        title="Reset position, zoom, rotation and flips"
                        className="flex items-center gap-1 text-xs font-medium text-text-secondary"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                      >
                        <RotateCcw size={13} /> Reset
                      </button>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-text-secondary">
                      Zoom
                      <input
                        type="range"
                        min={0.3}
                        max={3}
                        step={0.02}
                        value={tf.zoom}
                        onChange={(e) => setSlot(i, { zoom: parseFloat(e.target.value) })}
                        style={{ flex: 1 }}
                      />
                      <span style={{ width: 38, textAlign: 'right' }}>{Math.round(tf.zoom * 100)}%</span>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-text-secondary">
                      Rotate
                      <input
                        type="range"
                        min={-180}
                        max={180}
                        step={1}
                        value={tf.rotation}
                        onChange={(e) => setSlot(i, { rotation: parseInt(e.target.value, 10) })}
                        style={{ flex: 1 }}
                      />
                      <span style={{ width: 38, textAlign: 'right' }}>{tf.rotation}°</span>
                    </label>
                    <div className="flex gap-2 text-xs font-medium">
                      <button
                        type="button"
                        title="Rotate 90° anticlockwise"
                        onClick={() => setSlot(i, { rotation: tf.rotation - 90 < -180 ? tf.rotation + 270 : tf.rotation - 90 })}
                        className="flex items-center gap-1"
                        style={toolBtn(false)}
                      >
                        <RotateCcw size={13} /> 90°
                      </button>
                      <button
                        type="button"
                        title="Rotate 90° clockwise"
                        onClick={() => setSlot(i, { rotation: tf.rotation + 90 > 180 ? tf.rotation - 270 : tf.rotation + 90 })}
                        className="flex items-center gap-1"
                        style={toolBtn(false)}
                      >
                        <RotateCw size={13} /> 90°
                      </button>
                      <button
                        type="button"
                        title="Flip horizontally (mirror)"
                        onClick={() => setSlot(i, { flipH: !tf.flipH })}
                        className="flex items-center gap-1"
                        style={toolBtn(tf.flipH)}
                      >
                        <FlipHorizontal2 size={13} /> Flip
                      </button>
                      <button
                        type="button"
                        title="Flip vertically"
                        onClick={() => setSlot(i, { flipV: !tf.flipV })}
                        className="flex items-center gap-1"
                        style={toolBtn(tf.flipV)}
                      >
                        <FlipVertical2 size={13} /> Flip
                      </button>
                    </div>
                  </div>
                );
              })}

              <p className="text-xs text-text-secondary" style={{ lineHeight: 1.5 }}>
                Tip: drag a photo in the preview to slide it; use the sliders to zoom and straighten it.
                Both photos print on the top half of the A4 — the dashed lines show where to cut.
                After you create it, pick a preset (e.g. <b>High Contrast</b> for a scanned look) and print.
              </p>

              {err && <div className="text-xs" style={{ color: 'var(--color-tag-pink-text)' }}>{err}</div>}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-3" style={{ padding: '14px 20px', borderTop: '1px solid var(--color-border)' }}>
          {arranging ? (
            <button
              type="button"
              onClick={back}
              disabled={generating}
              className="text-sm font-semibold rounded-pill"
              style={{ padding: '10px 18px', background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', cursor: 'pointer' }}
            >
              ← Change photos
            </button>
          ) : (
            <span className="text-sm font-medium text-text-secondary">{selected.length} / 2 selected</span>
          )}
          {!arranging && err && <span className="text-xs" style={{ color: 'var(--color-tag-pink-text)' }}>{err}</span>}
          <button
            type="button"
            onClick={generate}
            disabled={!arranging || generating}
            className="ml-auto flex items-center justify-center gap-2 text-sm font-semibold rounded-pill"
            style={{
              padding: '11px 22px',
              background: 'var(--color-brand)',
              color: 'var(--color-brand-fg)',
              border: 'none',
              cursor: !arranging || generating ? 'not-allowed' : 'pointer',
              opacity: !arranging || generating ? 0.6 : 1,
            }}
          >
            {generating ? <Spinner size={15} color="var(--color-brand-fg)" /> : <Images size={15} />}
            {generating ? 'Creating…' : 'Create & continue →'}
          </button>
        </div>
      </div>
    </div>
  );
}
