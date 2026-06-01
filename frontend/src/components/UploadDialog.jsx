'use client';
import { useState } from 'react';
import { Spinner } from './Spinner';

export function UploadDialog({ onDone }) {
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const file = e.target.elements.file.files[0];
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('customer', customer || 'walk-in');
      const res = await fetch('/api/jobs/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(await res.text());
      setOpen(false);
      setCustomer('');
      onDone?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-pill font-semibold text-sm"
        style={{
          padding: '6px 14px',
          background: 'var(--color-bg-overlay)',
          color: 'var(--color-text-primary)',
          border: '1px solid var(--color-border)',
          cursor: 'pointer',
        }}
      >
        + Upload
      </button>
      {open && (
        <div
          onClick={() => !busy && setOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
          }}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={submit}
            style={{
              background: 'var(--color-bg-surface)',
              borderRadius: 20,
              padding: 24,
              width: 380,
              boxShadow: '0 12px 48px rgba(0,0,0,0.2)',
            }}
            className="flex flex-col gap-3"
          >
            <h3 className="font-bold" style={{ fontSize: 18 }}>Upload file</h3>
            <input
              name="customer"
              placeholder="Customer name (optional)"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              style={{
                padding: '10px 12px',
                background: 'var(--color-bg-overlay)',
                border: '1px solid var(--color-border)',
                borderRadius: 10,
                fontSize: 14,
              }}
            />
            <input
              name="file"
              type="file"
              required
              accept=".jpg,.jpeg,.png,.pdf,.docx"
              style={{ fontSize: 14 }}
            />
            {err && <div className="text-xs" style={{ color: 'var(--color-tag-pink-text)' }}>{err}</div>}
            <div className="flex justify-end gap-2 mt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-pill text-sm"
                style={{
                  padding: '8px 16px',
                  background: 'transparent',
                  border: '1px solid var(--color-border)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex items-center gap-2 rounded-pill text-sm font-semibold"
                style={{
                  padding: '8px 16px',
                  background: 'var(--color-brand)',
                  color: 'var(--color-brand-fg)',
                  border: 'none',
                  cursor: busy ? 'wait' : 'pointer',
                }}
              >
                {busy && <Spinner size={13} color="var(--color-brand-fg)" />}
                {busy ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
