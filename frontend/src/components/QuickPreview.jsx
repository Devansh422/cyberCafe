'use client';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Printer, Trash2, Download, Check, X } from 'lucide-react';
import { api, fileUrl } from '@/lib/api';
import { Avatar } from './Avatar';
import { DeptTag, DateBadge } from './Tags';
import { Spinner } from './Spinner';
import { fmtDateShort, fmtBytes, STATUS_LABEL, TYPE_LABEL, dateBadgeTone } from '@/lib/format';

// Bottom-right confirmation that a file was copied to the PC. Rendered through a
// portal to <body> so it's anchored to the viewport, not the (animated, and
// therefore transform-containing) preview column.
function SaveToast({ toast, onClose }) {
  return (
    <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 80, maxWidth: 380 }} className="toast-enter">
      <div
        style={{
          background: 'var(--color-bg-surface)',
          borderRadius: 14,
          boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
          border: '1px solid var(--color-border)',
          padding: '14px 16px',
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
        }}
      >
        <span
          style={{
            flexShrink: 0,
            width: 32,
            height: 32,
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: toast.ok ? 'var(--color-tag-green-bg)' : 'var(--color-tag-pink-bg)',
            color: toast.ok ? 'var(--color-tag-green-text)' : 'var(--color-tag-pink-text)',
          }}
        >
          {toast.ok ? <Check size={18} /> : <X size={18} />}
        </span>
        <div className="min-w-0">
          <div className="font-semibold" style={{ fontSize: 14 }}>
            {toast.ok ? 'Saved to PC' : 'Save failed'}
          </div>
          {toast.ok ? (
            <>
              <div className="text-xs" style={{ color: 'var(--color-text-primary)', wordBreak: 'break-word', marginTop: 2 }}>
                {toast.filename}
              </div>
              <div className="text-xs" style={{ color: 'var(--color-text-secondary)', wordBreak: 'break-word', marginTop: 2 }}>
                {toast.dir}
              </div>
            </>
          ) : (
            <div className="text-xs" style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>
              {toast.error}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="dismiss"
          className="text-text-secondary"
          style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

// Quick view of the selected item. Presets and printing live in the Process
// modal (opened via the primary CTA) — here we show a glance of the file plus
// Process/Print, Save-to-PC, and a compact Delete.
export function QuickPreview({ job, onProcess, onDelete }) {
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { ok, filename, dir } | { ok:false, error }

  if (!job) {
    return (
      <div
        style={{ background: 'var(--color-bg-surface)', borderRadius: 16, padding: 24, flex: 1, minHeight: 0, boxShadow: 'var(--shadow-card)' }}
        className="flex items-center justify-center text-text-secondary text-sm"
      >
        Select a file to preview.
      </div>
    );
  }

  const showProcessed = ['processed', 'printed', 'printing'].includes(job.status);
  const previewUrl = fileUrl(job.id, showProcessed && job.processed_path);
  const isImage = job.type === 'image' && !showProcessed;
  // Mirror the modal's status-aware CTA: printable items lead with Print.
  const printable = ['processed', 'printing', 'printed'].includes(job.status);

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await onDelete?.(job.id);
    } finally {
      setDeleting(false);
    }
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await api.saveJob(job.id);
      setToast({ ok: true, filename: res.filename, dir: res.dir });
    } catch (e) {
      setToast({ ok: false, error: e.message || 'Could not save the file' });
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 4500);
    }
  }

  return (
    <div
      style={{ background: 'var(--color-bg-surface)', borderRadius: 16, padding: 16, boxShadow: 'var(--shadow-card)', flex: 1, minHeight: 0 }}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <DeptTag icon>{TYPE_LABEL[job.type] || 'FILE'}</DeptTag>
        <DateBadge tone={dateBadgeTone(job.created_at)}>{fmtDateShort(job.created_at)}</DateBadge>
      </div>

      <div className="font-semibold" style={{ fontSize: 15, wordBreak: 'break-word' }}>
        {job.original_name || job.filename}
      </div>

      <div className="flex items-center gap-3 text-sm text-text-secondary">
        <Avatar name={job.customer_name || job.customer_phone || '?'} size={28} />
        <div>
          <div className="text-text-primary font-medium">{job.customer_name || 'Unknown'}</div>
          <div className="text-xs">{job.customer_phone || '—'} · {fmtBytes(job.size)}</div>
        </div>
        <span
          className="ml-auto text-xs font-semibold rounded-pill"
          style={{ padding: '3px 10px', background: 'var(--color-bg-overlay)', color: 'var(--color-text-secondary)' }}
        >
          {STATUS_LABEL[job.status] || job.status}
        </span>
      </div>

      {/* Quick view of the file — grows to fill the column height */}
      <div
        style={{
          background: 'var(--color-bg-overlay)',
          borderRadius: 12,
          flex: 1,
          minHeight: 200,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt={job.filename} style={{ maxWidth: '100%', maxHeight: '100%' }} />
        ) : (
          <iframe src={previewUrl} title={job.filename} style={{ width: '100%', height: '100%', border: 'none' }} />
        )}
      </div>

      {/* Process/Print (primary) + icon-only Delete */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={deleting}
          onClick={() => onProcess?.(job)}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-semibold rounded-pill"
          style={{ padding: '11px 16px', background: 'var(--color-brand)', color: 'var(--color-brand-fg)', border: 'none' }}
        >
          {printable ? <><Printer size={16} /> Print</> : <><Sparkles size={16} /> Process</>}
        </button>
        <button
          type="button"
          aria-label="Delete file"
          title="Delete"
          disabled={deleting}
          onClick={handleDelete}
          className="flex items-center justify-center rounded-pill"
          style={{
            width: 44,
            height: 44,
            background: 'var(--color-tag-pink-bg)',
            color: 'var(--color-tag-pink-text)',
            border: '1px solid var(--color-tag-pink-text)',
            flexShrink: 0,
          }}
        >
          {deleting ? <Spinner size={16} /> : <Trash2 size={17} />}
        </button>
      </div>

      {/* Save a copy to the PC's Downloads folder */}
      <button
        type="button"
        disabled={saving}
        onClick={handleSave}
        className="flex items-center justify-center gap-2 text-sm font-semibold rounded-pill"
        style={{
          padding: '10px 16px',
          background: 'var(--color-bg-overlay)',
          color: 'var(--color-text-primary)',
          border: '1px solid var(--color-border)',
          cursor: saving ? 'wait' : 'pointer',
        }}
      >
        {saving ? <Spinner size={15} /> : <Download size={16} />}
        {saving ? 'Saving…' : 'Save to PC'}
      </button>

      {toast && typeof document !== 'undefined' &&
        createPortal(<SaveToast toast={toast} onClose={() => setToast(null)} />, document.body)}
    </div>
  );
}
