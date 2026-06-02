'use client';
import useSWR from 'swr';
import { useEffect, useRef, useState } from 'react';
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
  logging_out: 'yellow',
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
  logging_out: 'Disconnecting…',
};

export function WhatsAppStatus() {
  const { data, mutate } = useSWR('/system/whatsapp/qr', api.fetcher, { refreshInterval: 3000 });
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [revoking, setRevoking] = useState(false);

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
  const fg = textMap[tone];

  const linked = status === 'ready' || status === 'authenticated';
  const connecting = starting || status === 'starting' || status === 'awaiting_qr' || status === 'logging_out';

  // Fire the one-shot "linked!" celebration only on the transition into a
  // connected state — not on every 3s poll that re-confirms it.
  const prevStatus = useRef(status);
  const [justLinked, setJustLinked] = useState(false);
  useEffect(() => {
    const wasLinked = prevStatus.current === 'ready' || prevStatus.current === 'authenticated';
    prevStatus.current = status;
    if (linked && !wasLinked) {
      setJustLinked(true);
      const t = setTimeout(() => setJustLinked(false), 2600);
      return () => clearTimeout(t);
    }
  }, [status, linked]);

  async function start() {
    setStarting(true);
    try { await api.startWhatsapp(); await mutate(); }
    catch (e) { console.error(e); }
    finally { setStarting(false); }
  }

  async function revoke() {
    if (!window.confirm('Disconnect this WhatsApp number? The linked device will be removed and you’ll need to scan a new QR code to link a different number.')) return;
    setRevoking(true);
    try { await api.logoutWhatsapp(); await mutate(); }
    catch (e) { console.error(e); }
    finally { setRevoking(false); }
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
            position: 'relative',
            width: 14,
            height: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {linked ? (
            <span
              className={justLinked ? 'wa-pop' : undefined}
              style={{ position: 'relative', width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {justLinked && <span className="wa-burst" style={{ border: `2px solid ${fg}` }} />}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={fg} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                <path className={justLinked ? 'check-draw' : undefined} d="M5 13l4 4L19 7" />
              </svg>
            </span>
          ) : connecting ? (
            <>
              <span className="wa-ripple" style={{ border: `1.5px solid ${fg}` }} />
              <span className="wa-breathe" style={{ width: 8, height: 8, borderRadius: 999, background: fg }} />
            </>
          ) : (
            <span style={{ width: 8, height: 8, borderRadius: 999, background: fg, display: 'inline-block' }} />
          )}
        </span>
        WhatsApp · {justLinked ? 'Linked!' : label}
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
            {data?.qr && !linked ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={data.qr} alt="WhatsApp QR" style={{ width: '100%', borderRadius: 12 }} />
            ) : (
              <div
                className="flex flex-col items-center justify-center gap-3 text-sm text-text-secondary"
                style={{
                  background: 'var(--color-bg-overlay)',
                  borderRadius: 12,
                  height: 320,
                  textAlign: 'center',
                  padding: 20,
                }}
              >
                {linked ? (
                  <>
                    <span
                      className={justLinked ? 'wa-pop' : undefined}
                      style={{ position: 'relative', width: 64, height: 64, borderRadius: 999, background: 'var(--color-tag-green-bg)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      {justLinked && <span className="wa-burst" style={{ border: '2px solid var(--color-tag-green-text)' }} />}
                      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--color-tag-green-text)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path className={justLinked ? 'check-draw' : undefined} d="M5 13l4 4L19 7" />
                      </svg>
                    </span>
                    <span>WhatsApp is connected. Files sent to your number will appear in Incoming.</span>
                  </>
                ) : status === 'unavailable' ? (
                  <span>Run &quot;npm install&quot; in /backend to enable WhatsApp import.</span>
                ) : connecting ? (
                  <>
                    <span style={{ position: 'relative', width: 56, height: 56, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span className="wa-ripple" style={{ border: '2px solid var(--color-tag-yellow-text)' }} />
                      <span className="wa-ripple" style={{ border: '2px solid var(--color-tag-yellow-text)', animationDelay: '0.7s' }} />
                      <span className="wa-breathe" style={{ width: 16, height: 16, borderRadius: 999, background: 'var(--color-tag-yellow-text)' }} />
                    </span>
                    <span>{label} — connecting to WhatsApp…</span>
                  </>
                ) : (
                  <span>Waiting for QR…</span>
                )}
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
            {(status === 'ready' || status === 'authenticated') && (
              <button
                onClick={revoke}
                disabled={revoking}
                className="rounded-pill font-semibold text-sm"
                style={{
                  background: 'transparent',
                  color: 'var(--color-tag-pink-text)',
                  padding: '8px 16px',
                  border: '1.5px solid var(--color-tag-pink-text)',
                  cursor: revoking ? 'wait' : 'pointer',
                }}
              >
                {revoking ? 'Disconnecting…' : 'Disconnect & use another number'}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
