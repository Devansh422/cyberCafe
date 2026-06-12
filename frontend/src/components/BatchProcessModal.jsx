'use client';
import { useEffect, useState } from 'react';
import { X, Check, Layers, FileText, Sparkles } from 'lucide-react';
import { api, fileUrl } from '@/lib/api';
import { Avatar } from './Avatar';
import { Spinner } from './Spinner';
import { fmtBytes } from '@/lib/format';

// Presets the operator can render the batch with (kept in sync with the Control
// Panel — the Passport preset was removed).
const PRESETS = [
  { id: 'scan_pdf', label: 'Scan PDF' },
  { id: 'bw', label: 'Black & White' },
  { id: 'color', label: 'Color' },
  { id: 'high_contrast', label: 'High Contrast' },
  { id: 'a4_resize', label: 'A4 Resize' },
  { id: 'inverted', label: 'Inverted' },
];

// One selectable item in the batch. Clicking the card toggles it; the preview
// shows the ORIGINAL incoming file (image inline, anything else in an iframe).
function SelectableCard({ job, selected, onToggle }) {
  const isImage = job.type === 'image';
  const src = fileUrl(job.id, false);
  return (
    <button
      type="button"
      onClick={() => onToggle(job.id)}
      className="text-left flex flex-col"
      style={{
        background: 'var(--color-bg-surface)',
        borderRadius: 14,
        border: selected ? '2px solid var(--color-brand)' : '1px solid var(--color-border)',
        boxShadow: selected ? '0 0 0 3px var(--color-tag-green-bg)' : 'var(--shadow-card)',
        overflow: 'hidden',
        cursor: 'pointer',
        position: 'relative',
        transition: 'box-shadow 120ms, border-color 120ms',
      }}
    >
      <span
        className="flex items-center justify-center rounded-pill"
        style={{
          position: 'absolute', top: 8, right: 8, zIndex: 2,
          width: 26, height: 26,
          background: selected ? 'var(--color-brand)' : 'rgba(255,255,255,0.85)',
          color: selected ? 'var(--color-brand-fg)' : 'var(--color-text-secondary)',
          border: '1px solid var(--color-border)',
        }}
      >
        {selected ? <Check size={15} /> : null}
      </span>

      <div
        style={{
          background: 'var(--color-bg-overlay)',
          height: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={job.filename} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        ) : (
          <iframe
            src={`${src}#toolbar=0&navpanes=0&view=FitH`}
            title={job.filename}
            style={{ width: '100%', height: '100%', border: 'none', pointerEvents: 'none' }}
          />
        )}
      </div>

      <div className="flex items-center gap-2" style={{ padding: '9px 11px' }}>
        {isImage ? null : <FileText size={14} />}
        <span
          className="font-semibold"
          style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {job.original_name || job.filename}
        </span>
        <span className="ml-auto text-xs text-text-secondary" style={{ whiteSpace: 'nowrap' }}>
          {fmtBytes(job.size)}
        </span>
      </div>
    </button>
  );
}

// Batch workspace launched from a batch's "Process batch" button. Previews every
// file the customer sent together, lets the operator pick a subset and a preset,
// then processes the selection with that preset and merges it into ONE printable
// PDF (via /jobs/merge). The merged job is handed back so the parent can drop the
// operator straight into the print popup.
export function BatchProcessModal({ jobs = [], batchId = null, onClose, onMerged }) {
  // Default: everything selected.
  const [selected, setSelected] = useState(() => new Set(jobs.map((j) => j.id)));
  const [preset, setPreset] = useState('scan_pdf');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const selectAll = () => setSelected(new Set(jobs.map((j) => j.id)));
  const clearAll = () => setSelected(new Set());

  const customer = jobs[0]?.customer_name || jobs[0]?.customer_phone || 'Unknown';
  const count = selected.size;

  async function processAndMerge() {
    const ids = jobs.map((j) => j.id).filter((id) => selected.has(id)); // keep order
    if (ids.length < 1 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // A single selected item still merges fine (a 1-page PDF), so the flow is
      // uniform whether they pick one or all.
      const job = await api.mergeJobs(ids, preset);
      await onMerged?.(job);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div
      onClick={() => { if (!busy) onClose?.(); }}
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
          <span
            className="flex items-center justify-center rounded-pill"
            style={{ width: 32, height: 32, background: 'var(--color-brand)', color: 'var(--color-brand-fg)' }}
          >
            <Layers size={16} />
          </span>
          <div className="flex flex-col min-w-0">
            <h2 className="font-bold" style={{ fontSize: 17 }}>Process batch · {jobs.length} files</h2>
            <span className="text-xs text-text-secondary">
              Pick the files and a preset, then merge them into one printable PDF.
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Avatar name={customer} size={26} />
            <button
              type="button"
              onClick={selectAll}
              disabled={busy || jobs.length === 0}
              className="text-xs font-semibold rounded-pill"
              style={{ padding: '6px 12px', background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={clearAll}
              disabled={busy || count === 0}
              className="text-xs font-semibold rounded-pill"
              style={{ padding: '6px 12px', background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              Clear
            </button>
            <button
              onClick={() => { if (!busy) onClose?.(); }}
              aria-label="close"
              className="flex items-center justify-center text-text-secondary hover:text-text-primary"
              style={{ width: 34, height: 34, borderRadius: 999, background: 'var(--color-bg-overlay)', border: 'none', cursor: 'pointer' }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Grid of selectable previews */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, background: 'var(--color-bg-app)' }}>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {jobs.map((job) => (
              <SelectableCard key={job.id} job={job} selected={selected.has(job.id)} onToggle={toggle} />
            ))}
          </div>
        </div>

        {/* Footer: preset picker + merge action */}
        <div className="flex flex-col gap-3" style={{ padding: '14px 20px', borderTop: '1px solid var(--color-border)' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide flex items-center gap-1.5">
              <Sparkles size={13} /> Preset
            </span>
            {PRESETS.map((p) => {
              const active = preset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={busy}
                  onClick={() => setPreset(p.id)}
                  className="text-xs font-medium rounded-pill"
                  style={{
                    padding: '7px 14px',
                    background: active ? 'var(--color-brand)' : 'var(--color-bg-overlay)',
                    color: active ? 'var(--color-brand-fg)' : 'var(--color-text-secondary)',
                    border: '1px solid',
                    borderColor: active ? 'var(--color-brand)' : 'var(--color-border)',
                    cursor: busy ? 'not-allowed' : 'pointer',
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm font-medium flex items-center gap-2">
              <Check size={16} style={{ color: count >= 1 ? 'var(--color-tag-green-text)' : 'var(--color-text-secondary)' }} />
              {count} of {jobs.length} selected
            </span>
            {err && <span className="text-xs" style={{ color: 'var(--color-tag-pink-text)' }}>{err}</span>}
            <button
              type="button"
              onClick={processAndMerge}
              disabled={count < 1 || busy}
              className="ml-auto flex items-center justify-center gap-2 text-sm font-semibold rounded-pill"
              style={{
                padding: '11px 22px',
                background: 'var(--color-brand)',
                color: 'var(--color-brand-fg)',
                border: 'none',
                cursor: count < 1 || busy ? 'not-allowed' : 'pointer',
                opacity: count < 1 || busy ? 0.6 : 1,
              }}
            >
              {busy ? <Spinner size={15} color="var(--color-brand-fg)" /> : <Layers size={15} />}
              {busy ? 'Processing & merging…' : `Process & merge → PDF${count >= 1 ? ` (${count})` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
