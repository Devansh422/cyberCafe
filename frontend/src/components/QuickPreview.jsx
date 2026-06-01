'use client';
import { useState } from 'react';
import { Sparkles, Printer, Trash2 } from 'lucide-react';
import { fileUrl } from '@/lib/api';
import { Avatar } from './Avatar';
import { DeptTag, DateBadge } from './Tags';
import { Spinner } from './Spinner';
import { fmtDateShort, fmtBytes, STATUS_LABEL, TYPE_LABEL, dateBadgeTone } from '@/lib/format';

// Quick view of the selected item. Presets and printing have moved into the
// Process modal (opened via the primary "Process" CTA) — here we only show a
// glance of the file plus Process and a compact icon-only Delete.
export function QuickPreview({ job, onProcess, onDelete }) {
  const [deleting, setDeleting] = useState(false);

  if (!job) {
    return (
      <div
        style={{ background: 'var(--color-bg-surface)', borderRadius: 16, padding: 24, minHeight: 320, boxShadow: 'var(--shadow-card)' }}
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

  return (
    <div
      style={{ background: 'var(--color-bg-surface)', borderRadius: 16, padding: 16, boxShadow: 'var(--shadow-card)' }}
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

      {/* Quick view of the file */}
      <div
        style={{
          background: 'var(--color-bg-overlay)',
          borderRadius: 12,
          height: 340,
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

      {/* Process (primary) + icon-only Delete */}
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
    </div>
  );
}
