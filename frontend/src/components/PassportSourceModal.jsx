'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { X, Check, MessageCircle, Loader2, Sparkles } from 'lucide-react';
import { api, fileUrl, passportPreviewUrl } from '@/lib/api';
import { Avatar } from './Avatar';
import { fmtDateShort } from '@/lib/format';

// Picker for pulling passport source photos from WhatsApp incoming images.
// Selecting a photo immediately runs the passport pipeline (face centring +
// background removal with the page's current colour) and swaps the raw
// thumbnail for the PROCESSED preview, so the operator sees the actual passport
// photo before adding it. Confirming hands the prepared results back to the
// Passport page, which reuses them instead of preparing again.
export function PassportSourceModal({ bg, onClose, onConfirm }) {
  const { data } = useSWR('/jobs?status=incoming&limit=500', api.fetcher, { refreshInterval: 5000 });
  const images = (data?.jobs || []).filter((j) => j.type === 'image');

  const [selected, setSelected] = useState(() => new Set());
  // jobId → { status: 'preparing' | 'ready' | 'error', result?, error? }.
  // Kept after deselection as a cache, so re-selecting is instant.
  const [prepared, setPrepared] = useState({});

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function prepare(jobId) {
    setPrepared((prev) => ({ ...prev, [jobId]: { status: 'preparing' } }));
    try {
      const res = await api.preparePassportFromJob(jobId, bg);
      setPrepared((prev) => ({ ...prev, [jobId]: { status: 'ready', result: res } }));
    } catch (e) {
      setPrepared((prev) => ({ ...prev, [jobId]: { status: 'error', error: e.message } }));
    }
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    const entry = prepared[id];
    if (!selected.has(id) && (!entry || entry.status === 'error')) prepare(id);
  }

  const count = selected.size;
  const preparingCount = [...selected].filter((id) => prepared[id]?.status === 'preparing').length;

  function confirm() {
    if (!count || preparingCount) return;
    const entries = images
      .filter((j) => selected.has(j.id))
      .map((j) => ({
        jobId: j.id,
        prepared: prepared[j.id]?.status === 'ready' ? prepared[j.id].result : null,
      }));
    onConfirm?.(entries);
  }

  return (
    <div
      onClick={() => onClose?.()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: '3vh 3vw' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-enter flex flex-col"
        style={{ background: 'var(--color-bg-surface)', borderRadius: 20, width: '84vw', height: '86vh', boxShadow: '0 24px 80px rgba(0,0,0,0.28)', overflow: 'hidden' }}
      >
        <div className="flex items-center gap-3" style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border)' }}>
          <span className="flex items-center justify-center rounded-pill" style={{ width: 32, height: 32, background: '#25D366', color: '#fff' }}>
            <MessageCircle size={16} />
          </span>
          <div className="flex flex-col">
            <h2 className="font-bold" style={{ fontSize: 17 }}>Add from WhatsApp</h2>
            <span className="text-xs text-text-secondary">
              Pick incoming photos — selecting one shows its processed passport preview (face centred, background removed).
            </span>
          </div>
          <button
            onClick={() => onClose?.()}
            aria-label="close"
            className="ml-auto flex items-center justify-center text-text-secondary hover:text-text-primary"
            style={{ width: 34, height: 34, borderRadius: 999, background: 'var(--color-bg-overlay)', border: 'none', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, background: 'var(--color-bg-app)' }}>
          {images.length === 0 ? (
            <div className="flex items-center justify-center text-sm text-text-secondary" style={{ height: '100%' }}>
              No incoming WhatsApp photos right now.
            </div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {images.map((job) => {
                const sel = selected.has(job.id);
                const entry = prepared[job.id];
                const showProcessed = sel && entry?.status === 'ready';
                return (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => toggle(job.id)}
                    className="text-left flex flex-col"
                    style={{
                      background: 'var(--color-bg-surface)',
                      borderRadius: 12,
                      border: sel ? '2px solid var(--color-brand)' : '1px solid var(--color-border)',
                      boxShadow: sel ? '0 0 0 3px var(--color-tag-green-bg)' : 'var(--shadow-card)',
                      overflow: 'hidden', cursor: 'pointer', position: 'relative',
                    }}
                  >
                    <span
                      className="flex items-center justify-center rounded-pill"
                      style={{ position: 'absolute', top: 6, right: 6, zIndex: 2, width: 24, height: 24, background: sel ? 'var(--color-brand)' : 'rgba(255,255,255,0.85)', color: sel ? 'var(--color-brand-fg)' : 'transparent', border: '1px solid var(--color-border)' }}
                    >
                      <Check size={14} />
                    </span>
                    <div style={{ height: 150, background: 'var(--color-bg-overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={showProcessed ? passportPreviewUrl(entry.result.id) : fileUrl(job.id)}
                        alt={job.filename}
                        style={{ width: '100%', height: '100%', objectFit: showProcessed ? 'contain' : 'cover' }}
                      />
                      {sel && entry?.status === 'preparing' && (
                        <span
                          className="flex items-center justify-center gap-1.5 text-xs font-medium"
                          style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.7)', color: 'var(--color-text-primary)' }}
                        >
                          <Loader2 size={14} className="lucide-spin" /> Processing…
                        </span>
                      )}
                      {showProcessed && (
                        <span
                          className="inline-flex items-center gap-1 text-xs font-semibold rounded-pill"
                          style={{ position: 'absolute', left: 6, bottom: 6, padding: '2px 8px', background: 'var(--color-tag-green-bg)', color: 'var(--color-tag-green-text)' }}
                        >
                          <Sparkles size={10} /> Processed
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-text-secondary" style={{ padding: '7px 9px' }}>
                      <Avatar name={job.customer_name || job.customer_phone || '?'} size={18} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job.customer_name || 'Unknown'}
                      </span>
                      <span className="ml-auto" style={{ whiteSpace: 'nowrap' }}>{fmtDateShort(job.created_at)}</span>
                    </div>
                    {sel && entry?.status === 'error' && (
                      <span className="text-xs" style={{ padding: '0 9px 7px', color: 'var(--color-tag-pink-text)' }}>
                        Preview failed — it will be retried after adding.
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3" style={{ padding: '14px 20px', borderTop: '1px solid var(--color-border)' }}>
          <span className="text-sm font-medium">{count} selected</span>
          {preparingCount > 0 && (
            <span className="text-xs text-text-secondary flex items-center gap-1.5">
              <Loader2 size={12} className="lucide-spin" /> processing {preparingCount}…
            </span>
          )}
          <button
            type="button"
            onClick={confirm}
            disabled={count < 1 || preparingCount > 0}
            className="ml-auto flex items-center justify-center gap-2 text-sm font-semibold rounded-pill"
            style={{ padding: '11px 22px', background: 'var(--color-brand)', color: 'var(--color-brand-fg)', border: 'none', cursor: count < 1 || preparingCount > 0 ? 'not-allowed' : 'pointer', opacity: count < 1 || preparingCount > 0 ? 0.6 : 1 }}
          >
            Add {count > 0 ? count : ''} photo{count === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
