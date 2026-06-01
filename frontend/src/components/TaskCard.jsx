
'use client';
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Avatar } from './Avatar';
import { DeptTag, DateBadge } from './Tags';
import { StatusTimeline } from './StatusTimeline';
import { Spinner } from './Spinner';
import { fmtDateShort, dateBadgeTone, STATUS_LABEL, TYPE_LABEL } from '@/lib/format';

function nextStepLabel(status) {
  switch (status) {
    case 'incoming':
      return 'Process';
    case 'processed':
      return 'Print';
    case 'queued':
      return 'Printing';
    case 'printing':
      return 'Printed';
    case 'printed':
      return 'Done';
    case 'failed':
      return 'Retry or delete';
    default:
      return 'Review';
  }
}

export function TaskCard({
  job,
  onClick,
  selected,
  variant = 'card',
  timelineKey,
  showQueued = false,
  showDelete = false,
  onDelete,
}) {
  const [deleting, setDeleting] = useState(false);
  const completed = job.status === 'printed';
  const failed = job.status === 'failed';
  const tone = failed ? 'pink' : dateBadgeTone(job.created_at);

  async function handleDelete(e) {
    e.stopPropagation();
    if (deleting) return;
    setDeleting(true);
    try {
      await onDelete?.(job.id);
    } finally {
      setDeleting(false);
    }
  }
  const isList = variant === 'list';
  const activeKey = timelineKey || job.status;
  const nextLabel = nextStepLabel(activeKey);
  const statusLabel = STATUS_LABEL[activeKey] || STATUS_LABEL[job.status] || activeKey;
  const canDelete = showDelete;
  const background = completed
    ? 'var(--color-accent-green-bg)'
    : failed
    ? 'var(--color-tag-pink-bg)'
    : 'var(--color-bg-surface)';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left flex transition-all`}
      style={{
        background,
        borderRadius: 16,
        boxShadow: selected
          ? '0 4px 16px rgba(0,0,0,0.12), 0 0 0 2px #111'
          : 'var(--shadow-card)',
        padding: isList ? 14 : 16,
        minHeight: isList ? 96 : 168,
        cursor: 'pointer',
        flexDirection: isList ? 'row' : 'column',
        gap: isList ? 16 : 12,
        border: isList ? '1px solid var(--color-border)' : 'none',
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.boxShadow = 'var(--shadow-card-hover)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.boxShadow = 'var(--shadow-card)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {isList ? (
        <div
          className="w-full"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 16,
            alignItems: 'center',
          }}
        >
          <div className="flex flex-col gap-2 min-w-0">
            <div
              className="font-semibold"
              style={{
                fontSize: 15,
                color: 'var(--color-text-primary)',
                lineHeight: 1.5,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}
            >
              {job.original_name || job.filename}
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <StatusTimeline status={job.status} currentKey={activeKey} showQueued={showQueued} />
              <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                Next: {nextLabel}
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2" style={{ textAlign: 'right', minWidth: 180 }}>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <DeptTag icon>{TYPE_LABEL[job.type] || 'FILE'}</DeptTag>
              <DateBadge tone={tone}>{fmtDateShort(job.created_at)}</DateBadge>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex flex-col items-end">
                <span className="text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                  {job.customer_name || job.customer_phone || 'Unknown'}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    {statusLabel}
                  </span>
                  {canDelete && (
                    <button
                      type="button"
                      aria-label="Delete file"
                      title="Delete"
                      disabled={deleting}
                      onClick={handleDelete}
                      className="flex items-center justify-center"
                      style={{
                        color: 'var(--color-tag-pink-text)',
                        background: 'var(--color-tag-pink-bg)',
                        border: '1px solid var(--color-tag-pink-text)',
                        borderRadius: 999,
                        width: 26,
                        height: 26,
                        cursor: deleting ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {deleting ? <Spinner size={12} /> : <Trash2 size={13} />}
                    </button>
                  )}
                </div>
              </div>
              <Avatar name={job.customer_name || job.customer_phone || '?'} size={32} />
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <DeptTag icon>{TYPE_LABEL[job.type] || 'FILE'}</DeptTag>
            <DateBadge tone={tone}>{fmtDateShort(job.created_at)}</DateBadge>
          </div>

          <div
            className="font-semibold flex-1"
            style={{
              fontSize: 14,
              color: 'var(--color-text-primary)',
              lineHeight: 1.4,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
            }}
          >
            {job.original_name || job.filename}
          </div>

          <div className="flex items-end justify-between mt-auto">
            <div className="flex flex-col gap-2">
              <StatusTimeline status={job.status} currentKey={activeKey} showQueued={showQueued} />
              <div className="text-sm text-text-secondary">Next: {nextLabel}</div>
            </div>
            <Avatar name={job.customer_name || job.customer_phone || '?'} size={28} />
          </div>
        </>
      )}
    </button>
  );
}

export function AddTaskCard({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-2 text-text-muted hover:text-text-secondary transition-colors"
      style={{
        background: 'transparent',
        border: '1.5px dashed var(--color-border-dashed)',
        borderRadius: 16,
        minHeight: 168,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-text-secondary)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--color-border-dashed)')}
    >
      <span style={{ fontSize: 24, fontWeight: 300 }}>+</span>
      <span className="text-sm font-medium">Upload file</span>
    </button>
  );
}
