'use client';
import useSWR from 'swr';
import { useState } from 'react';
import { api } from '@/lib/api';

const STATUS_TONE = {
  ready: 'green',
  authenticated: 'green',
  awaiting_qr: 'yellow',
  starting: 'yellow',
  disconnected: 'pink',
  auth_failed: 'pink',
  error: 'pink',
  disabled: 'pink',
  idle: 'yellow',
  unavailable: 'pink',
};

const STATUS_LABEL = {
  ready: 'Connected',
  authenticated: 'Authenticated',
  awaiting_qr: 'Scan QR',
  starting: 'Starting…',
  disconnected: 'Disconnected',
  auth_failed: 'Auth failed',
  error: 'Error',
  disabled: 'Disabled',
  idle: 'Idle',
  unavailable: 'Install backend deps',
};

export function WhatsAppStatus() {
  const { data, mutate } = useSWR('/system/whatsapp/qr', api.fetcher, { refreshInterval: 3000 });
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const status = data?.status || 'idle';
  const tone = STATUS_TONE[status] || 'yellow';
  const label = STATUS_LABEL[status] || status;
  const colorMap = {
    green: 'var(--color-tag-green-bg)',
    yellow: 'var(--color-tag-yellow-bg)',
    pink: 'var(--color-tag-pink-bg)',
  };
  const textMap = {
    green: 'var(--color-tag-green-text)',
    yellow: 'var(--color-tag-yellow-text)',
    pink: 'var(--color-tag-pink-text)',
  };

  async function start() {
    setStarting(true);
    try { await api.startWhatsapp(); await mutate(); }
    catch (e) { console.error(e); }
    finally { setStarting(false); }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-pill text-xs font-semibold"
        style={{
          padding: '6px 12px',
          background: colorMap[tone],
          color: textMap[tone],
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: textMap[tone],
            display: 'inline-block',
          }}
        />
        WhatsApp · {label}
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--color-bg-surface)',
              borderRadius: 20,
              padding: 24,
              width: 380,
              boxShadow: '0 12px 48px rgba(0,0,0,0.2)',
            }}
            className="flex flex-col gap-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-bold" style={{ fontSize: 18 }}>WhatsApp Login</h3>
              <button onClick={() => setOpen(false)} aria-label="close" className="text-text-secondary">✕</button>
            </div>
            <div className="text-sm text-text-secondary">Status: {label}</div>
            {data?.qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={data.qr} alt="WhatsApp QR" style={{ width: '100%', borderRadius: 12 }} />
            ) : (
              <div
                className="flex items-center justify-center text-sm text-text-secondary"
                style={{
                  background: 'var(--color-bg-overlay)',
                  borderRadius: 12,
                  height: 320,
                  textAlign: 'center',
                  padding: 20,
                }}
              >
                {status === 'ready'
                  ? 'WhatsApp is connected. Files sent to your number will appear in Incoming.'
                  : status === 'unavailable'
                  ? 'Run "npm install" in /backend to enable WhatsApp import.'
                  : 'Waiting for QR…'}
              </div>
            )}
            {data?.lastError && (
              <div className="text-xs" style={{ color: 'var(--color-tag-pink-text)' }}>
                {data.lastError}
              </div>
            )}
            <button
              onClick={start}
              disabled={starting}
              className="rounded-pill font-semibold text-sm"
              style={{
                background: 'var(--color-brand)',
                color: 'var(--color-brand-fg)',
                padding: '10px 16px',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {starting ? 'Starting…' : status === 'ready' ? 'Restart' : 'Start / Refresh QR'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
