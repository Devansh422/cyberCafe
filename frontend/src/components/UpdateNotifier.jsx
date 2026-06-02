'use client';
// The update prompt card. Reads shared state from UpdateContext (the automatic
// launch check and the nav "Check for updates" button both feed it). Shows when
// an update is available, while it's downloading, or if an install failed.
import { useUpdate } from './UpdateContext';

export function UpdateNotifier() {
  const ctx = useUpdate();
  if (!ctx) return null;
  const { phase, info, pct, err, install, dismiss } = ctx;
  if (phase === 'idle') return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        width: 360,
        background: 'var(--color-bg-surface)',
        borderRadius: 16,
        padding: 18,
        boxShadow: '0 12px 48px rgba(0,0,0,0.22)',
        zIndex: 100,
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <span
          style={{
            width: 9, height: 9, borderRadius: 999,
            background: 'var(--color-tag-green-text)', display: 'inline-block',
          }}
        />
        <h3 className="font-bold" style={{ fontSize: 16 }}>
          Update available{info?.version ? ` · v${info.version}` : ''}
        </h3>
      </div>

      {info?.body ? (
        <p className="text-sm text-text-secondary" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
          {info.body}
        </p>
      ) : (
        <p className="text-sm text-text-secondary">A newer version of Ratan is ready to install.</p>
      )}

      {phase === 'downloading' && (
        <div className="flex flex-col gap-1">
          <div style={{ height: 6, borderRadius: 999, background: 'var(--color-border)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--color-brand)', transition: 'width .2s' }} />
          </div>
          <span className="text-xs text-text-muted">Downloading… {pct}% — the app will restart automatically.</span>
        </div>
      )}

      {phase === 'error' && (
        <div className="text-xs" style={{ color: 'var(--color-tag-pink-text)' }}>
          Update failed: {err}
        </div>
      )}

      {phase !== 'downloading' && (
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={dismiss}
            className="rounded-pill text-sm font-semibold"
            style={{ padding: '8px 16px', background: 'transparent', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)', cursor: 'pointer' }}
          >
            Later
          </button>
          <button
            onClick={install}
            className="rounded-pill text-sm font-semibold"
            style={{ padding: '8px 18px', background: 'var(--color-brand)', color: 'var(--color-brand-fg)', border: 'none', cursor: 'pointer' }}
          >
            {phase === 'error' ? 'Retry' : 'Install & restart'}
          </button>
        </div>
      )}
    </div>
  );
}
