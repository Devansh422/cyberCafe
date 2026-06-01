'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { X, Check, Layers, FileText, ImageIcon, CheckCircle2 } from 'lucide-react';
import { api, fileUrl } from '@/lib/api';
import { Avatar } from './Avatar';
import { Spinner } from './Spinner';
import { fmtBytes, fmtDateShort } from '@/lib/format';

// A selectable card for one processed item. The whole card toggles selection;
// the preview iframe has pointer-events disabled so clicks land on the card.
function SelectableCard({ job, selected, onToggle }) {
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
      {/* Select badge */}
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

      <div className="flex items-center gap-2" style={{ padding: '9px 11px' }}>
        {job.type === 'image' ? <ImageIcon size={14} /> : <FileText size={14} />}
        <span
          className="font-semibold"
          style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {job.original_name || job.filename}
        </span>
      </div>

      <div
        style={{
          background: 'var(--color-bg-overlay)',
          height: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {/* Processed items render to PDF — preview the processed file. */}
        <iframe
          src={`${fileUrl(job.id, true)}#toolbar=0&navpanes=0&view=FitH`}
          title={job.filename}
          style={{ width: '100%', height: '100%', border: 'none', pointerEvents: 'none' }}
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-text-secondary" style={{ padding: '7px 11px' }}>
        <Avatar name={job.customer_name || job.customer_phone || '?'} size={20} />
        <span className="text-text-primary font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.customer_name || 'Unknown'}
        </span>
        <span className="ml-auto" style={{ whiteSpace: 'nowrap' }}>
          {job.pages ? `${job.pages}p · ` : ''}{fmtBytes(job.size)}
        </span>
      </div>
    </button>
  );
}

// Popup launched from the Processed tab's "Create batch" button. Lists every
// processed item as a selectable card with a live preview; the operator picks
// several and merges them into one printable PDF.
export function CreateBatchModal({ onClose, onCreated }) {
  const { data } = useSWR('/jobs?status=processed&limit=500', api.fetcher, { refreshInterval: 4000 });
  const jobs = (data?.jobs || []).filter((j) => j.status === 'processed');

  const [selected, setSelected] = useState(() => new Set());
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

  function selectAll() {
    setSelected(new Set(jobs.map((j) => j.id)));
  }
  function clearAll() {
    setSelected(new Set());
  }

  async function createBatch() {
    const ids = jobs.map((j) => j.id).filter((id) => selected.has(id)); // keep list order
    if (ids.length < 2 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const job = await api.mergeJobs(ids);
      await onCreated?.(job);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  const count = selected.size;

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
            <h2 className="font-bold" style={{ fontSize: 17 }}>Create batch</h2>
            <span className="text-xs text-text-secondary">Select processed items to merge into one printable PDF.</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
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

        {/* Grid of selectable cards */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, background: 'var(--color-bg-app)' }}>
          {jobs.length === 0 ? (
            <div className="flex items-center justify-center text-sm text-text-secondary" style={{ height: '100%' }}>
              No processed items to batch yet.
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
            >
              {jobs.map((job) => (
                <SelectableCard key={job.id} job={job} selected={selected.has(job.id)} onToggle={toggle} />
              ))}
            </div>
          )}
        </div>

        {/* Footer action bar */}
        <div className="flex items-center gap-3" style={{ padding: '14px 20px', borderTop: '1px solid var(--color-border)' }}>
          <span className="text-sm font-medium flex items-center gap-2">
            <CheckCircle2 size={16} style={{ color: count >= 2 ? 'var(--color-tag-green-text)' : 'var(--color-text-secondary)' }} />
            {count} selected
            {count > 0 && count < 2 && <span className="text-xs text-text-secondary">· pick at least 2</span>}
          </span>
          {err && <span className="text-xs" style={{ color: 'var(--color-tag-pink-text)' }}>{err}</span>}
          <button
            type="button"
            onClick={createBatch}
            disabled={count < 2 || busy}
            className="ml-auto flex items-center justify-center gap-2 text-sm font-semibold rounded-pill"
            style={{
              padding: '11px 22px',
              background: 'var(--color-brand)',
              color: 'var(--color-brand-fg)',
              border: 'none',
              cursor: count < 2 || busy ? 'not-allowed' : 'pointer',
              opacity: count < 2 || busy ? 0.6 : 1,
            }}
          >
            {busy ? <Spinner size={15} color="var(--color-brand-fg)" /> : <Layers size={15} />}
            {busy ? 'Merging…' : `Create batch${count >= 2 ? ` (${count})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
