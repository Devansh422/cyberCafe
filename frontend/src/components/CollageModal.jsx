'use client';
import { useEffect, useRef, useState } from 'react';
import { X, Check, Images, RotateCcw, ImageIcon } from 'lucide-react';
import { api, fileUrl } from '@/lib/api';
import { Avatar } from './Avatar';
import { Spinner } from './Spinner';

// Cell rectangles as page fractions [x, y, w, h] (top-down). MUST stay in sync
// with `collage_cells` in crates/ratan-core/src/processing.rs so the live
// preview matches the generated PDF.
const COLLAGE_CELLS = {
  vertical: [[0.06, 0.05, 0.88, 0.42], [0.06, 0.53, 0.88, 0.42]],
  horizontal: [[0.05, 0.06, 0.43, 0.88], [0.52, 0.06, 0.43, 0.88]],
};

const DEFAULT_TF = { zoom: 1, panX: 0, panY: 0 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Tiny inline glyphs for the layout toggle (two boxes stacked vs side-by-side).
function LayoutGlyph({ kind }) {
  return kind === 'vertical' ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="2" y="2" width="12" height="5" rx="1" />
      <rect x="2" y="9" width="12" height="5" rx="1" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="2" y="2" width="5" height="12" rx="1" />
      <rect x="9" y="2" width="5" height="12" rx="1" />
    </svg>
  );
}

// One photo placed inside its A4 cell. translate is in % of the element (which
// fills the cell), so panX/panY of ±1 shifts by half a cell — matching the
// server's `pan * (cell/2)`. object-fit:contain gives the same baseline scale.
function CollageCell({ rect, id, tf, onPan }) {
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
        border: '1px dashed var(--color-border)',
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
          transform: `translate(${tf.panX * 50}%, ${tf.panY * 50}%) scale(${tf.zoom})`,
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
// page. Produces a processed PDF job (then drops into the print popup).
export function CollageModal({ jobs = [], onClose, onCreated }) {
  const photos = jobs.filter((j) => j.type === 'image');
  const [selected, setSelected] = useState([]); // ordered [id, id]
  const [transforms, setTransforms] = useState([{ ...DEFAULT_TF }, { ...DEFAULT_TF }]);
  const [layout, setLayout] = useState('vertical');
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState(null);

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
      }));
      const job = await api.makeCollage(layout, items);
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
                        <Avatar name={job.customer_name || job.customer_phone || '?'} size={20} />
                        <span className="text-text-primary font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {job.customer_name || job.customer_phone || 'Unknown'}
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
                    onPan={(panX, panY) => setSlot(i, { panX, panY })}
                  />
                ))}
                {/* Cut hint between the two halves */}
                <div
                  style={
                    layout === 'vertical'
                      ? { position: 'absolute', left: '4%', right: '4%', top: '50%', borderTop: '1px dashed var(--color-text-muted)' }
                      : { position: 'absolute', top: '4%', bottom: '4%', left: '50%', borderLeft: '1px dashed var(--color-text-muted)' }
                  }
                />
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
              </div>

              {selected.map((id, i) => {
                const job = photos.find((j) => j.id === id);
                return (
                  <div key={id} className="flex flex-col gap-2" style={{ background: 'var(--color-bg-overlay)', borderRadius: 12, padding: 12 }}>
                    <div className="flex items-center gap-2">
                      <span className="flex items-center justify-center rounded-pill" style={{ width: 22, height: 22, background: 'var(--color-brand)', color: 'var(--color-brand-fg)', fontSize: 12, fontWeight: 700 }}>
                        {i + 1}
                      </span>
                      <span className="text-sm font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job?.original_name || job?.filename || `Photo ${i + 1}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => resetSlot(i)}
                        title="Reset position"
                        className="ml-auto flex items-center gap-1 text-xs font-medium text-text-secondary"
                        style={{ background: 'none', border: 'none', cursor: 'pointer' }}
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
                        value={transforms[i].zoom}
                        onChange={(e) => setSlot(i, { zoom: parseFloat(e.target.value) })}
                        style={{ flex: 1 }}
                      />
                      <span style={{ width: 38, textAlign: 'right' }}>{Math.round(transforms[i].zoom * 100)}%</span>
                    </label>
                  </div>
                );
              })}

              <p className="text-xs text-text-secondary" style={{ lineHeight: 1.5 }}>
                Tip: drag a photo in the preview to slide it. The dashed line shows where to cut after printing.
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
            {generating ? 'Creating…' : 'Create collage →'}
          </button>
        </div>
      </div>
    </div>
  );
}
