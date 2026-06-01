'use client';
import { useState } from 'react';
import { Layers, Sparkles, Trash2 } from 'lucide-react';
import { Avatar } from './Avatar';
import { TaskCard } from './TaskCard';
import { Spinner } from './Spinner';
import { fmtDateShort } from '@/lib/format';

// Renders a group of files a customer sent at once (within the batch window).
// The batch can be processed/printed or deleted as a unit via the header
// actions, while each item below still has its own select + delete.
export function BatchCard({ jobs, batchId, selectedId, onSelect, onProcess, onDeleteBatch, onDeleteItem }) {
  const [deleting, setDeleting] = useState(false);
  const customer = jobs[0]?.customer_name || jobs[0]?.customer_phone || 'Unknown';

  async function handleDeleteBatch() {
    if (deleting) return;
    if (!window.confirm(`Delete this batch of ${jobs.length} file(s)? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await onDeleteBatch?.(batchId);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      style={{
        background: 'var(--color-bg-overlay)',
        border: '1px solid var(--color-border)',
        borderRadius: 18,
        padding: 12,
      }}
      className="flex flex-col gap-2"
    >
      {/* Batch header */}
      <div className="flex items-center gap-2" style={{ padding: '2px 4px' }}>
        <span
          className="flex items-center justify-center rounded-pill"
          style={{ width: 30, height: 30, background: 'var(--color-brand)', color: 'var(--color-brand-fg)' }}
        >
          <Layers size={15} />
        </span>
        <div className="flex flex-col min-w-0">
          <span className="font-bold" style={{ fontSize: 14 }}>
            Batch · {jobs.length} files
          </span>
          <span className="text-xs text-text-secondary" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {customer} · {fmtDateShort(jobs[0]?.created_at)}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Avatar name={customer} size={26} />
          <button
            type="button"
            disabled={deleting}
            onClick={() => onProcess?.(jobs.map((j) => j.id), batchId, jobs)}
            className="flex items-center gap-1.5 text-xs font-semibold rounded-pill"
            style={{ padding: '7px 13px', background: 'var(--color-brand)', color: 'var(--color-brand-fg)', border: 'none' }}
          >
            <Sparkles size={14} /> Process batch
          </button>
          <button
            type="button"
            aria-label="Delete batch"
            title="Delete batch"
            disabled={deleting}
            onClick={handleDeleteBatch}
            className="flex items-center justify-center rounded-pill"
            style={{
              width: 32,
              height: 32,
              background: 'var(--color-tag-pink-bg)',
              color: 'var(--color-tag-pink-text)',
              border: '1px solid var(--color-tag-pink-text)',
              flexShrink: 0,
            }}
          >
            {deleting ? <Spinner size={14} /> : <Trash2 size={15} />}
          </button>
        </div>
      </div>

      {/* Items in the batch */}
      <div className="flex flex-col gap-2">
        {jobs.map((job) => (
          <TaskCard
            key={job.id}
            job={job}
            selected={job.id === selectedId}
            onClick={() => onSelect(job.id)}
            variant="list"
            showDelete
            onDelete={onDeleteItem}
          />
        ))}
      </div>
    </div>
  );
}
