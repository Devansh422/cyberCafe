'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Trash2, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import { SectionHeader } from './SectionHeader';
import { TaskCard } from './TaskCard';
import { BatchCard } from './BatchCard';
import { QuickPreview } from './QuickPreview';
import { ProcessModal } from './ProcessModal';
import { BatchProcessModal } from './BatchProcessModal';
import { CreateBatchModal } from './CreateBatchModal';
import { UploadDialog } from './UploadDialog';
import { Spinner } from './Spinner';

// Tabs that support a "Clear all" bulk delete.
const CLEARABLE = new Set(['incoming', 'processed', 'printed']);

// Build an ordered render list for the incoming tab: files that arrived together
// (same batch_id, 2+ items) collapse into a single batch entry at the position
// of their first member; everything else renders as an individual card.
function buildList(jobs, groupBatches) {
  if (!groupBatches) return jobs.map((job) => ({ kind: 'job', job }));
  const byBatch = {};
  for (const j of jobs) if (j.batch_id) (byBatch[j.batch_id] ||= []).push(j);
  const seen = new Set();
  const items = [];
  for (const j of jobs) {
    const group = j.batch_id && byBatch[j.batch_id];
    if (group && group.length > 1) {
      if (seen.has(j.batch_id)) continue;
      seen.add(j.batch_id);
      items.push({ kind: 'batch', batchId: j.batch_id, jobs: group });
    } else {
      items.push({ kind: 'job', job: j });
    }
  }
  return items;
}

export function JobsView({ status, title, subtitle, showAdd = true, showHeader = true }) {
  const key = status ? `/jobs?status=${status}` : '/jobs';
  const { data, mutate } = useSWR(key, api.fetcher, { refreshInterval: 3000 });
  const [selectedId, setSelectedId] = useState(null);
  const [uploadKey] = useState(0);
  const [clearing, setClearing] = useState(false);
  // Open Process modal target: { ids, batchId, initialJobs } | null
  const [processTarget, setProcessTarget] = useState(null);
  // Open Batch process+merge modal target: { batchId, jobs } | null
  const [batchTarget, setBatchTarget] = useState(null);
  // Whether the "Create batch" picker is open (Processed tab only).
  const [batchOpen, setBatchOpen] = useState(false);

  const jobs = data?.jobs || [];
  const counts = data?.counts || {};
  const selected = jobs.find((j) => j.id === selectedId) || null;
  const totalForSection = status ? counts[status] || 0 : jobs.length;
  const groupBatches = status === 'incoming';
  const renderList = buildList(jobs, groupBatches);

  async function handleDelete(id) {
    try {
      await api.deleteJob(id);
      if (selectedId === id) setSelectedId(null);
      await mutate();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleDeleteBatch(batchId) {
    try {
      await api.deleteBatch(batchId);
      await mutate();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleClear() {
    if (!status || jobs.length === 0 || clearing) return;
    if (!window.confirm(`Delete all ${jobs.length} ${status} file(s)? This cannot be undone.`)) return;
    setClearing(true);
    try {
      await api.clearJobs(status);
      setSelectedId(null);
      await mutate();
    } catch (err) {
      console.error(err);
    } finally {
      setClearing(false);
    }
  }

  function openProcess(jobOrJob) {
    setProcessTarget({ ids: [jobOrJob.id], batchId: null, initialJobs: [jobOrJob] });
  }

  // A batch's "Process batch" opens the select + preset + merge workspace.
  function openProcessBatch(ids, batchId, batchJobs) {
    setBatchTarget({ batchId, jobs: batchJobs });
  }

  // After a merged PDF is produced (from either the incoming-batch workspace or
  // the Processed-tab picker), close the picker and drop the operator straight
  // into the print popup — the merged item is already processed, so the dynamic
  // CTA shows "Print".
  async function handleMerged(job) {
    setBatchTarget(null);
    setBatchOpen(false);
    await mutate();
    if (job?.id) {
      setSelectedId(job.id);
      setProcessTarget({ ids: [job.id], batchId: null, initialJobs: [job] });
    }
  }

  const hasClear = CLEARABLE.has(status) && jobs.length > 0;
  const hasUpload = !showHeader && showAdd;
  const hasCreateBatch = status === 'processed' && jobs.length >= 2;
  const listActions = (hasClear || hasUpload || hasCreateBatch) ? (
    <div className="flex items-center gap-2">
      {hasCreateBatch && (
        <button
          type="button"
          onClick={() => setBatchOpen(true)}
          className="flex items-center gap-1.5 text-xs font-semibold rounded-pill"
          style={{
            padding: '5px 12px',
            background: 'var(--color-brand)',
            color: 'var(--color-brand-fg)',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <Layers size={13} /> Create batch
        </button>
      )}
      {hasClear && (
        <button
          type="button"
          onClick={handleClear}
          disabled={clearing}
          className="flex items-center gap-1.5 text-xs font-semibold rounded-pill"
          style={{
            padding: '5px 12px',
            background: 'var(--color-tag-pink-bg)',
            color: 'var(--color-tag-pink-text)',
            border: '1px solid var(--color-tag-pink-text)',
            cursor: clearing ? 'not-allowed' : 'pointer',
          }}
        >
          {clearing ? <Spinner size={12} /> : <Trash2 size={13} />}
          {clearing ? 'Clearing…' : 'Clear all'}
        </button>
      )}
      {hasUpload && <UploadDialog key={uploadKey} onDone={() => mutate()} />}
    </div>
  ) : undefined;

  return (
    <div className="flex flex-col gap-4" style={{ height: '100%', minHeight: 0 }}>
      {showHeader && (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-bold tracking-tight" style={{ fontSize: 28, letterSpacing: '-0.02em' }}>
              {title}
            </h1>
            {subtitle && <p className="text-sm text-text-secondary mt-1">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">
            {showAdd && <UploadDialog key={uploadKey} onDone={() => mutate()} />}
          </div>
        </div>
      )}

      <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 1.4fr', minHeight: 0, height: '100%' }}>
        <section
          className="section-enter flex flex-col gap-3"
          style={{ minHeight: 0, overflowY: 'auto', paddingRight: 4 }}
        >
          <SectionHeader title={title} count={totalForSection} actions={listActions} />
          <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
            <span>Totals:</span>
            {Object.entries(counts).map(([k, v]) => (
              <span
                key={k}
                className="rounded-pill"
                style={{
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  padding: '3px 10px',
                }}
              >
                {k}: <b style={{ color: 'var(--color-text-primary)' }}>{v}</b>
              </span>
            ))}
          </div>
          {jobs.length === 0 ? (
            <div
              className="flex items-center justify-center text-sm text-text-secondary"
              style={{
                background: 'var(--color-bg-surface)',
                borderRadius: 16,
                padding: 40,
                boxShadow: 'var(--shadow-card)',
                minHeight: 168,
              }}
            >
              No files in this view yet.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {renderList.map((item) =>
                item.kind === 'batch' ? (
                  <BatchCard
                    key={`batch-${item.batchId}`}
                    jobs={item.jobs}
                    batchId={item.batchId}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onProcess={openProcessBatch}
                    onDeleteBatch={handleDeleteBatch}
                    onDeleteItem={handleDelete}
                  />
                ) : (
                  <TaskCard
                    key={item.job.id}
                    job={item.job}
                    selected={item.job.id === selectedId}
                    onClick={() => setSelectedId(item.job.id)}
                    variant="list"
                    showDelete
                    onDelete={handleDelete}
                  />
                )
              )}
            </div>
          )}
        </section>

        <section
          className="section-enter flex flex-col gap-2"
          style={{ minHeight: 0, overflowY: 'auto', paddingRight: 4 }}
        >
          <SectionHeader title="Preview" compact />
          <QuickPreview job={selected} onProcess={openProcess} onDelete={handleDelete} />
        </section>
      </div>

      {processTarget && (
        <ProcessModal
          ids={processTarget.ids}
          batchId={processTarget.batchId}
          initialJobs={processTarget.initialJobs}
          onClose={() => setProcessTarget(null)}
          onChange={() => mutate()}
        />
      )}

      {batchTarget && (
        <BatchProcessModal
          jobs={batchTarget.jobs}
          batchId={batchTarget.batchId}
          onClose={() => setBatchTarget(null)}
          onMerged={handleMerged}
        />
      )}

      {batchOpen && (
        <CreateBatchModal
          onClose={() => setBatchOpen(false)}
          onCreated={handleMerged}
        />
      )}
    </div>
  );
}
