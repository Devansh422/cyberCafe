'use client';
import useSWR from 'swr';
import { api } from '@/lib/api';

const TONE = {
  ok: { dot: '#16a34a', bg: 'rgba(22,163,74,0.08)', label: 'Healthy' },
  warn: { dot: '#d97706', bg: 'rgba(217,119,6,0.08)', label: 'Attention' },
  error: { dot: '#dc2626', bg: 'rgba(220,38,38,0.08)', label: 'Problem' },
};

function OverallBanner({ overall, summary }) {
  const t = TONE[overall] || TONE.warn;
  const msg =
    overall === 'ok'
      ? 'All systems healthy.'
      : overall === 'warn'
      ? 'Running, but some things need attention.'
      : 'One or more problems are blocking normal operation.';
  return (
    <div
      style={{
        background: t.bg,
        borderRadius: 16,
        padding: '16px 20px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <span style={{ width: 14, height: 14, borderRadius: 999, background: t.dot, flex: '0 0 auto' }} />
      <div className="flex-1">
        <div className="font-semibold">{msg}</div>
        <div className="text-sm text-text-secondary mt-0.5">
          {summary.ok} healthy · {summary.warn} attention · {summary.error} problem
        </div>
      </div>
    </div>
  );
}

function CheckRow({ c }) {
  const t = TONE[c.status] || TONE.warn;
  return (
    <div
      style={{
        background: 'var(--color-bg-surface)',
        borderRadius: 16,
        padding: 20,
        boxShadow: '0 1px 4px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04)',
        display: 'flex',
        gap: 14,
        alignItems: 'flex-start',
      }}
    >
      <span style={{ width: 12, height: 12, borderRadius: 999, background: t.dot, marginTop: 5, flex: '0 0 auto' }} />
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <span className="font-semibold">{c.label}</span>
          <span className="text-xs font-medium" style={{ color: t.dot }}>
            {t.label}
          </span>
        </div>
        <div className="text-sm text-text-secondary mt-1" style={{ wordBreak: 'break-word' }}>
          {c.detail}
        </div>
        {c.fix && (
          <div
            className="text-sm mt-2"
            style={{
              background: 'var(--color-bg-app)',
              borderRadius: 10,
              padding: '10px 12px',
              whiteSpace: 'pre-wrap',
            }}
          >
            <span className="font-semibold">Fix: </span>
            {c.fix}
          </div>
        )}
      </div>
    </div>
  );
}

export default function DiagnosticsPage() {
  const { data, error, isValidating, mutate } = useSWR('/system/diagnostics', api.fetcher, {
    refreshInterval: 15_000,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-bold tracking-tight" style={{ fontSize: 28, letterSpacing: '-0.02em' }}>
            Diagnostics
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            Automatic health checks for printing, WhatsApp, storage, and the database — with the fix for anything wrong.
          </p>
        </div>
        <button
          onClick={() => mutate()}
          className="text-sm font-semibold"
          style={{
            background: 'var(--color-brand)',
            color: 'var(--color-brand-fg)',
            borderRadius: 999,
            padding: '8px 18px',
          }}
        >
          {isValidating ? 'Checking…' : 'Re-run checks'}
        </button>
      </div>

      {error && (
        <div
          className="text-sm"
          style={{ background: TONE.error.bg, borderRadius: 16, padding: 20, boxShadow: 'var(--shadow-card)' }}
        >
          Could not reach the backend diagnostics endpoint. Is the backend running on its port? ({String(error.message)})
        </div>
      )}

      {data && <OverallBanner overall={data.overall} summary={data.summary} />}

      <div className="flex flex-col gap-2">
        {(data?.checks || []).map((c) => (
          <CheckRow key={c.id} c={c} />
        ))}
      </div>

      {data?.generatedAt && (
        <p className="text-xs text-text-secondary">
          Last checked {new Date(data.generatedAt).toLocaleTimeString()} · auto-refreshes every 15s
        </p>
      )}
    </div>
  );
}
