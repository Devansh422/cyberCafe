'use client';
import useSWR from 'swr';
import { Download, AlertTriangle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

const mb = (b) => (b / 1048576).toFixed(0);

// First-run / after-update setup gate. The heavy runtime components (models,
// onnxruntime.dll, SumatraPDF, the WhatsApp sidecar) are no longer bundled in the
// installer — they download once into app-data so auto-updates stay small. While
// that download runs (or fails), this covers the app with a progress screen. On a
// warm cache the backend reports "ready" on the first poll, so nothing shows.
export function ComponentsSetup() {
  const { data, mutate } = useSWR('/system/components', api.fetcher, {
    // Poll while not ready; stop once ready.
    refreshInterval: (d) => (d && d.phase === 'ready' ? 0 : 1200),
  });
  const [retrying, setRetrying] = useState(false);

  if (!data || data.phase === 'ready') return null;

  const error = data.phase === 'error';
  const pct = data.total > 0 ? Math.min(100, Math.round((data.received / data.total) * 100)) : 0;
  const current = (data.items || []).find((i) => i.state === 'downloading');

  async function retry() {
    setRetrying(true);
    try {
      await api.retryComponents();
      await mutate();
    } catch {
      /* the poll will resurface the error */
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--color-bg-app)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          width: 'min(460px, 92vw)',
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 16,
          padding: 28,
          boxShadow: 'var(--shadow-card)',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 999,
            margin: '0 auto 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: error ? 'var(--color-tag-pink-bg)' : 'var(--color-tag-blue-bg, var(--color-bg-overlay))',
            color: error ? 'var(--color-tag-pink-text)' : 'var(--color-brand)',
          }}
        >
          {error ? <AlertTriangle size={24} /> : <Download size={24} className={current ? 'lucide-spin' : undefined} />}
        </div>

        <h2 className="font-bold tracking-tight" style={{ fontSize: 20, letterSpacing: '-0.02em' }}>
          {error ? 'Setup needs a connection' : 'Setting up Ratan'}
        </h2>
        <p className="text-sm text-text-secondary" style={{ marginTop: 6 }}>
          {error
            ? "Couldn't download the required components. Check your internet connection and retry."
            : 'Downloading required components. This happens once — future updates will be much smaller.'}
        </p>

        {!error && (
          <>
            <div
              style={{
                marginTop: 18,
                height: 8,
                borderRadius: 999,
                background: 'var(--color-bg-overlay)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: 'var(--color-brand)',
                  borderRadius: 999,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <div className="text-xs text-text-secondary" style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between' }}>
              <span>{current ? current.file : 'Preparing…'}</span>
              <span>
                {mb(data.received)} / {mb(data.total)} MB
              </span>
            </div>
          </>
        )}

        {error && (
          <>
            {data.error && (
              <code
                className="text-xs"
                style={{ display: 'block', marginTop: 14, padding: '8px 10px', background: 'var(--color-bg-overlay)', borderRadius: 8, color: 'var(--color-text-secondary)', wordBreak: 'break-word' }}
              >
                {data.error}
              </code>
            )}
            <button
              type="button"
              onClick={retry}
              disabled={retrying}
              className="flex items-center justify-center gap-2 text-sm font-semibold rounded-pill"
              style={{
                margin: '18px auto 0',
                padding: '11px 22px',
                background: 'var(--color-brand)',
                color: 'var(--color-brand-fg)',
                border: 'none',
                cursor: retrying ? 'not-allowed' : 'pointer',
                opacity: retrying ? 0.6 : 1,
              }}
            >
              <RefreshCw size={15} className={retrying ? 'lucide-spin' : undefined} /> Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
}
