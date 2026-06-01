'use client';
import { useEffect } from 'react';
import useSWR from 'swr';
import { X, CheckCircle2, Loader2, FileText, ImageIcon } from 'lucide-react';
import { api, fileUrl } from '@/lib/api';
import { Avatar } from './Avatar';
import { ControlPanel } from './ControlPanel';
import { STATUS_LABEL, TYPE_LABEL, fmtBytes } from '@/lib/format';

const STATUS_TONE = {
  incoming: { bg: 'var(--color-bg-overlay)', fg: 'var(--color-text-secondary)' },
  processed: { bg: 'var(--color-tag-green-bg)', fg: 'var(--color-tag-green-text)' },
  printing: { bg: 'var(--color-tag-yellow-bg)', fg: 'var(--color-tag-yellow-text)' },
  printed: { bg: 'var(--color-tag-green-bg)', fg: 'var(--color-tag-green-text)' },
  failed: { bg: 'var(--color-tag-pink-bg)', fg: 'var(--color-tag-pink-text)' },
};

function ItemPreview({ job }) {
  const showProcessed = ['processed', 'printed', 'printing'].includes(job.status);
  const previewUrl = fileUrl(job.id, showProcessed && job.processed_path);
  const isImage = job.type === 'image' && !showProcessed;
  const tone = STATUS_TONE[job.status] || STATUS_TONE.incoming;

  return (
    <div
      style={{
        background: 'var(--color-bg-surface)',
        borderRadius: 14,
        border: '1px solid var(--color-border)',
        overflow: 'hidden',
      }}
      className="flex flex-col"
    >
      <div className="flex items-center gap-2" style={{ padding: '10px 12px' }}>
        {job.type === 'image' ? <ImageIcon size={15} /> : <FileText size={15} />}
        <span
          className="font-semibold"
          style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {job.original_name || job.filename}
        </span>
        <span
          className="ml-auto inline-flex items-center gap-1 text-xs font-semibold rounded-pill"
          style={{ padding: '2px 9px', background: tone.bg, color: tone.fg }}
        >
          {job.status === 'printing' && <Loader2 size={11} className="lucide-spin" />}
          {(job.status === 'processed' || job.status === 'printed') && <CheckCircle2 size={11} />}
          {STATUS_LABEL[job.status] || job.status}
        </span>
      </div>
      <div
        style={{
          background: 'var(--color-bg-overlay)',
          height: 360,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt={job.filename} style={{ maxWidth: '100%', maxHeight: '100%' }} />
        ) : (
          <iframe src={previewUrl} title={job.filename} style={{ width: '100%', height: '100%', border: 'none' }} />
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-text-secondary" style={{ padding: '8px 12px' }}>
        <Avatar name={job.customer_name || job.customer_phone || '?'} size={22} />
        <span className="text-text-primary font-medium">{job.customer_name || 'Unknown'}</span>
        <span className="ml-auto">{fmtBytes(job.size)}</span>
      </div>
    </div>
  );
}

// Full-screen (90%) processing workspace. Left: live preview of every item in
// the job/batch — the status pills and processed renders update as the backend
// works. The modal polls jobs by id itself (independent of the parent's
// status-filtered list, so items don't vanish once they leave "incoming").
// Right: the control panel.
export function ProcessModal({ ids = [], batchId = null, initialJobs = [], onClose, onChange }) {
  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { data, mutate } = useSWR('/jobs?limit=500', api.fetcher, { refreshInterval: 1500 });
  const idSet = new Set(ids);
  const live = (data?.jobs || []).filter((j) => idSet.has(j.id));
  // Keep the original order; fall back to the snapshot until the first poll lands.
  const jobs = ids
    .map((id) => live.find((j) => j.id === id) || initialJobs.find((j) => j.id === id))
    .filter(Boolean);

  async function handleChange() {
    await mutate();
    await onChange?.();
  }

  if (!jobs.length) return null;
  const first = jobs[0];
  const title = batchId && jobs.length > 1
    ? `Batch · ${jobs.length} files`
    : first.original_name || first.filename;

  return (
    <div
      onClick={onClose}
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
        <div
          className="flex items-center gap-3"
          style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <DeptType type={first.type} />
            <h2 className="font-bold" style={{ fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="close"
            className="ml-auto flex items-center justify-center text-text-secondary hover:text-text-primary"
            style={{ width: 34, height: 34, borderRadius: 999, background: 'var(--color-bg-overlay)', border: 'none', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body: preview (left) + control panel (right) */}
        <div className="grid" style={{ gridTemplateColumns: '1.6fr 1fr', flex: 1, minHeight: 0 }}>
          <div
            className="flex flex-col gap-3"
            style={{ padding: 20, overflowY: 'auto', background: 'var(--color-bg-app)' }}
          >
            {jobs.map((job) => (
              <ItemPreview key={job.id} job={job} />
            ))}
          </div>
          <div style={{ padding: 24, overflowY: 'auto', borderLeft: '1px solid var(--color-border)' }}>
            <ControlPanel jobs={jobs} batchId={batchId} onChange={handleChange} onClose={onClose} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DeptType({ type }) {
  return (
    <span
      className="inline-flex items-center gap-1 bg-dept-bg text-dept-fg font-semibold rounded-pill"
      style={{ fontSize: 11, padding: '3px 10px' }}
    >
      {TYPE_LABEL[type] || 'FILE'}
    </span>
  );
}
