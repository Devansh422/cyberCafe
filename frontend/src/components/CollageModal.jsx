'use client';
import { useEffect, useRef, useState } from 'react';
import { X, Images, RotateCcw, RotateCw, FlipHorizontal2, FlipVertical2, ImageIcon, Crop, SquarePen } from 'lucide-react';
import { api, fileUrl } from '@/lib/api';
import { Avatar } from './Avatar';
import { Spinner } from './Spinner';

// Cell rectangles as page fractions [x, y, w, h] (top-down). MUST stay in sync
// with `collage_cells` in crates/ratan-core/src/processing.rs so the live
// preview matches the generated PDF.
//   • vertical   — two wide cells stacked and CENTERED on the page (front/back
//                  of an ID, cut along the middle gap).
//   • horizontal — two cells side by side at the TOP of the page.
const COLLAGE_CELLS = {
  vertical: [[0.16, 0.235, 0.68, 0.24], [0.16, 0.525, 0.68, 0.24]],
  horizontal: [[0.04, 0.04, 0.44, 0.28], [0.52, 0.04, 0.44, 0.28]],
};

const DEFAULT_TF = { zoom: 1, panX: 0, panY: 0, rotation: 0, flipH: false, flipV: false };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Tiny inline glyphs for the layout toggle. The faint outline is the A4 page;
// the filled bars mirror where the two photos actually land — vertical stacked
// & centered, horizontal side-by-side at the top.
function LayoutGlyph({ kind }) {
  return kind === 'vertical' ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1.5" y="1" width="13" height="14" rx="1.2" fill="none" stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <rect x="3.6" y="5.3" width="8.8" height="2.4" rx="0.6" />
      <rect x="3.6" y="8.3" width="8.8" height="2.4" rx="0.6" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1.5" y="1" width="13" height="14" rx="1.2" fill="none" stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <rect x="3" y="2.8" width="4.4" height="4" rx="0.6" />
      <rect x="8.6" y="2.8" width="4.4" height="4" rx="0.6" />
    </svg>
  );
}

// One photo placed inside its A4 cell. translate is in % of the element (which
// fills the cell), so panX/panY of ±1 shifts by half a cell — matching the
// server's `pan * (cell/2)`. object-fit:contain gives the same baseline scale.
function CollageCell({ rect, id, version = 0, tf, onPan, guides, cellRef }) {
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
        src={`${fileUrl(id)}?v=${version}`}
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

// Starting corners (TL,TR,BR,BL) for the manual editor — a centered inset
// rectangle the operator drags onto the document corners.
const DEFAULT_CORNERS = [
  { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 },
];

// Full-screen overlay (above the collage modal) for the manual 4-corner crop.
// The operator drags the corner handles onto the document and "Flatten"
// perspective-warps the photo server-side — replacing the job's source with the
// upright crop. Corners are normalized [0,1] in image space.
function CornerCropOverlay({ id, version, onCancel, onApplied }) {
  const [corners, setCorners] = useState(() => DEFAULT_CORNERS.map((p) => ({ ...p }))); // [{x,y}×4]
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const boxRef = useRef(null);
  const dragIdx = useRef(null);

  const src = `${fileUrl(id)}?v=${version}`;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !applying) onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, applying]);

  function pointerDown(i, e) {
    e.preventDefault();
    e.stopPropagation();
    dragIdx.current = i;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }
  function pointerMove(e) {
    if (dragIdx.current == null) return;
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    const x = clamp((e.clientX - r.left) / r.width, 0, 1);
    const y = clamp((e.clientY - r.top) / r.height, 0, 1);
    setCorners((prev) => prev.map((p, idx) => (idx === dragIdx.current ? { x, y } : p)));
  }
  function pointerUp(e) {
    dragIdx.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  }

  function reset() {
    setCorners(DEFAULT_CORNERS.map((p) => ({ ...p })));
    setErr(null);
  }

  async function apply() {
    if (!corners || applying) return;
    setApplying(true);
    setErr(null);
    try {
      await api.warpCorners(id, corners.map((p) => [p.x, p.y]));
      onApplied?.();
    } catch (e) {
      setErr(e.message || 'Could not flatten');
      setApplying(false);
    }
  }

  const polyPoints = corners ? corners.map((p) => `${p.x * 100},${p.y * 100}`).join(' ') : '';

  return (
    <div
      onClick={() => { if (!applying) onCancel?.(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 70, padding: '3vh 3vw' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-enter flex flex-col"
        style={{ background: 'var(--color-bg-surface)', borderRadius: 16, maxWidth: 'min(94vw, 760px)', maxHeight: '94vh', overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.3)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3" style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)' }}>
          <span className="flex items-center justify-center rounded-pill" style={{ width: 30, height: 30, background: 'var(--color-brand)', color: 'var(--color-brand-fg)' }}>
            <Crop size={15} />
          </span>
          <div className="flex flex-col min-w-0">
            <span className="font-bold" style={{ fontSize: 15 }}>Adjust corners &amp; flatten</span>
            <span className="text-xs text-text-secondary">Drag the 4 dots onto the document corners, then flatten.</span>
          </div>
          <button
            onClick={() => { if (!applying) onCancel?.(); }}
            aria-label="close"
            className="ml-auto flex items-center justify-center text-text-secondary hover:text-text-primary"
            style={{ width: 32, height: 32, borderRadius: 999, background: 'var(--color-bg-overlay)', border: 'none', cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Image + corner handles */}
        <div className="flex items-center justify-center" style={{ padding: 16, background: 'var(--color-bg-app)', minHeight: 0, flex: 1, overflow: 'auto' }}>
          <div ref={boxRef} style={{ position: 'relative', display: 'inline-block', lineHeight: 0, touchAction: 'none' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              draggable={false}
              onLoad={() => setLoaded(true)}
              style={{ display: 'block', maxWidth: '100%', maxHeight: '66vh', objectFit: 'contain', userSelect: 'none', borderRadius: 4 }}
            />
            {loaded && corners && (
              <>
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                  <polygon points={polyPoints} fill="rgba(59,130,246,0.16)" stroke="#3b82f6" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                </svg>
                {corners.map((p, i) => (
                  <div
                    key={i}
                    onPointerDown={(e) => pointerDown(i, e)}
                    onPointerMove={pointerMove}
                    onPointerUp={pointerUp}
                    onPointerCancel={pointerUp}
                    style={{
                      position: 'absolute',
                      left: `${p.x * 100}%`,
                      top: `${p.y * 100}%`,
                      width: 20, height: 20, marginLeft: -10, marginTop: -10,
                      borderRadius: '50%',
                      background: '#fff',
                      border: '3px solid #3b82f6',
                      boxShadow: '0 1px 5px rgba(0,0,0,0.45)',
                      cursor: 'grab',
                      touchAction: 'none',
                    }}
                  />
                ))}
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3" style={{ padding: '12px 16px', borderTop: '1px solid var(--color-border)' }}>
          <button
            type="button"
            onClick={reset}
            disabled={applying}
            className="flex items-center gap-1 text-xs font-semibold rounded-pill"
            style={{ padding: '9px 14px', background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', cursor: applying ? 'wait' : 'pointer' }}
          >
            <RotateCcw size={13} /> Reset corners
          </button>
          {err && <span className="text-xs" style={{ color: 'var(--color-tag-pink-text)' }}>{err}</span>}
          <button
            type="button"
            onClick={apply}
            disabled={applying || !corners}
            className="ml-auto flex items-center justify-center gap-2 text-sm font-semibold rounded-pill"
            style={{ padding: '10px 20px', background: 'var(--color-brand)', color: 'var(--color-brand-fg)', border: 'none', cursor: applying || !corners ? 'not-allowed' : 'pointer', opacity: applying || !corners ? 0.6 : 1 }}
          >
            {applying ? <Spinner size={14} color="var(--color-brand-fg)" /> : <Crop size={14} />}
            {applying ? 'Flattening…' : 'Flatten'}
          </button>
        </div>
      </div>
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
  const [cropSlot, setCropSlot] = useState(null); // slot whose corner editor is open
  const [versions, setVersions] = useState([0, 0]); // bump to cache-bust a flattened cell
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
    setVersions([0, 0]);
    setErr(null);
  }

  // The corner editor flattened the photo in `slot` (its source file was
  // replaced server-side). Reset that cell's transform so the upright crop fits
  // cleanly, and bump its version to bust the cached <img>.
  function onCropApplied(slot) {
    resetSlot(slot);
    setVersions((prev) => prev.map((v, i) => (i === slot ? v + 1 : v)));
    setCropSlot(null);
    setErr(null);
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
                    version={versions[i]}
                    tf={transforms[i]}
                    guides={guides}
                    onPan={(panX, panY) => setSlot(i, { panX, panY })}
                    cellRef={cellEls[i]}
                  />
                ))}
                {/* Cut hint in the gap between the two cells. */}
                {guides && (
                  <div
                    style={
                      layout === 'vertical'
                        ? { position: 'absolute', left: '16%', right: '16%', top: '49.5%', borderTop: '1px dashed var(--color-text-muted)' }
                        : { position: 'absolute', top: '4%', height: '28%', left: '50%', borderLeft: '1px dashed var(--color-text-muted)' }
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
                        onClick={() => setCropSlot(i)}
                        title="Mark the document corners and flatten the photo"
                        className="ml-auto flex items-center gap-1 text-xs font-semibold"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-brand)', flexShrink: 0 }}
                      >
                        <SquarePen size={12} /> Edit
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
                Tip: use <b>Edit</b> to mark a tilted ID's corners and straighten it, then drag it in the
                preview to slide it and the sliders to zoom. The dashed lines show where to cut.
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

      {cropSlot !== null && selected[cropSlot] != null && (
        <CornerCropOverlay
          id={selected[cropSlot]}
          version={versions[cropSlot]}
          onCancel={() => setCropSlot(null)}
          onApplied={() => onCropApplied(cropSlot)}
        />
      )}
    </div>
  );
}
