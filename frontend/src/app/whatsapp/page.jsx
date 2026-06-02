'use client';
import useSWR from 'swr';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';

const STATUS_STEPS = [
  { key: 'idle', label: 'Not started', done: false },
  { key: 'starting', label: 'Starting browser…', done: false },
  { key: 'loading', label: 'Loading WhatsApp…', done: false },
  { key: 'awaiting_qr', label: 'Scan QR code', done: false },
  { key: 'authenticated', label: 'Authenticated', done: true },
  { key: 'ready', label: 'Connected & listening', done: true },
];

function QrCountdown({ age }) {
  const remaining = Math.max(0, 60 - (age || 0));
  const pct = (remaining / 60) * 100;
  const color = remaining > 20 ? 'var(--color-tag-green-text)' : remaining > 10 ? 'var(--color-tag-yellow-text)' : 'var(--color-tag-pink-text)';
  return (
    <div className="flex items-center gap-2 text-sm" style={{ color }}>
      <svg width="40" height="40" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="17" fill="none" stroke="var(--color-border)" strokeWidth="3" />
        <circle
          cx="20" cy="20" r="17"
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeDasharray={`${2 * Math.PI * 17}`}
          strokeDashoffset={`${2 * Math.PI * 17 * (1 - pct / 100)}`}
          strokeLinecap="round"
          style={{ transform: 'rotate(-90deg)', transformOrigin: 'center', transition: 'stroke-dashoffset 1s linear' }}
        />
        <text x="20" y="24" textAnchor="middle" fontSize="11" fill={color} fontWeight="700">{remaining}s</text>
      </svg>
      <span>QR expires in {remaining}s</span>
    </div>
  );
}

export default function WhatsAppPage() {
  const { data, mutate } = useSWR('/system/whatsapp/qr', api.fetcher, { refreshInterval: 2000 });
  const [starting, setStarting] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const status = data?.status || 'idle';
  const qr = data?.qr;
  const qrAge = data?.qrAge || 0;
  const isReady = status === 'ready';
  const isConnected = status === 'ready' || status === 'authenticated';
  const hasError = ['auth_failed', 'error', 'disconnected', 'unavailable'].includes(status);

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
    <div className="flex flex-col gap-6" style={{ maxWidth: 720 }}>
      <div>
        <h1 className="font-bold tracking-tight" style={{ fontSize: 28, letterSpacing: '-0.02em' }}>
          WhatsApp Setup
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Link your WhatsApp to automatically import customer files for printing.
        </p>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: qr ? '1fr 1fr' : '1fr' }}>
        <div
          style={{
            background: 'var(--color-bg-surface)',
            borderRadius: 20,
            padding: 24,
            boxShadow: 'var(--shadow-card)',
          }}
          className="flex flex-col gap-4"
        >
          <h2 className="font-bold" style={{ fontSize: 18 }}>Status</h2>

          <div className="flex flex-col gap-3">
            {STATUS_STEPS.map((step) => {
              const isCurrent = step.key === status;
              const isDone =
                step.done ||
                STATUS_STEPS.findIndex((s) => s.key === status) >
                  STATUS_STEPS.findIndex((s) => s.key === step.key);
              return (
                <div key={step.key} className="flex items-center gap-3">
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 999,
                      border: `2px solid ${
                        isCurrent
                          ? 'var(--color-brand)'
                          : isDone
                          ? 'var(--color-tag-green-text)'
                          : 'var(--color-border)'
                      }`,
                      background: isDone ? 'var(--color-accent-green-bg)' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      flexShrink: 0,
                    }}
                  >
                    {isDone ? '✓' : isCurrent ? '●' : ''}
                  </div>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: isCurrent ? 600 : 400,
                      color: isCurrent
                        ? 'var(--color-text-primary)'
                        : isDone
                        ? 'var(--color-tag-green-text)'
                        : 'var(--color-text-muted)',
                    }}
                  >
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>

          {data?.lastError && (
            <div
              className="text-sm rounded-md"
              style={{
                background: 'var(--color-tag-pink-bg)',
                color: 'var(--color-tag-pink-text)',
                padding: '10px 14px',
              }}
            >
              {data.lastError}
            </div>
          )}

          {isConnected ? (
            <div className="flex flex-col gap-3">
              <div
                className="rounded-md text-sm font-semibold"
                style={{
                  background: 'var(--color-accent-green-bg)',
                  color: 'var(--color-tag-green-text)',
                  padding: '12px 16px',
                }}
              >
                ✓ Connected! Files sent to your WhatsApp will appear in Incoming automatically.
              </div>
              <button
                onClick={revoke}
                disabled={revoking}
                className="rounded-pill font-semibold text-sm"
                style={{
                  padding: '10px 18px',
                  background: 'transparent',
                  color: 'var(--color-tag-pink-text)',
                  border: '1.5px solid var(--color-tag-pink-text)',
                  cursor: revoking ? 'wait' : 'pointer',
                  opacity: revoking ? 0.7 : 1,
                }}
              >
                {revoking ? 'Disconnecting…' : 'Disconnect & use another number'}
              </button>
            </div>
          ) : (
            <button
              onClick={start}
              disabled={starting || status === 'starting' || status === 'loading' || status === 'logging_out'}
              className="rounded-pill font-semibold text-sm"
              style={{
                padding: '12px 20px',
                background: 'var(--color-brand)',
                color: 'var(--color-brand-fg)',
                border: 'none',
                cursor: starting ? 'wait' : 'pointer',
                opacity: starting ? 0.7 : 1,
              }}
            >
              {status === 'logging_out'
                ? 'Disconnecting…'
                : starting
                ? 'Starting…'
                : status === 'idle'
                ? 'Start WhatsApp'
                : 'Restart / New QR'}
            </button>
          )}
        </div>

        {qr && (
          <div
            style={{
              background: 'var(--color-bg-surface)',
              borderRadius: 20,
              padding: 24,
              boxShadow: 'var(--shadow-card)',
            }}
            className="flex flex-col items-center gap-4"
          >
            <h2 className="font-bold self-start" style={{ fontSize: 18 }}>Scan QR Code</h2>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qr}
              alt="WhatsApp QR Code"
              style={{ width: '100%', maxWidth: 280, borderRadius: 12, border: '1px solid var(--color-border)' }}
            />
            <QrCountdown age={qrAge} />
            <ol className="text-sm text-text-secondary flex flex-col gap-1" style={{ alignSelf: 'stretch' }}>
              <li>1. Open WhatsApp on your phone</li>
              <li>2. Tap ⋮ Menu → <b>Linked Devices</b></li>
              <li>3. Tap <b>Link a Device</b></li>
              <li>4. Point camera at QR above</li>
            </ol>
          </div>
        )}

        {!qr && !isReady && status !== 'idle' && (
          <div
            style={{
              background: 'var(--color-bg-overlay)',
              borderRadius: 20,
              padding: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              color: 'var(--color-text-secondary)',
            }}
          >
            {status === 'starting' || status === 'loading'
              ? 'Browser launching, QR will appear shortly…'
              : 'Click Start to generate a QR code.'}
          </div>
        )}
      </div>

      <div
        style={{
          background: 'var(--color-bg-surface)',
          borderRadius: 16,
          padding: 20,
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <h3 className="font-semibold" style={{ fontSize: 15, marginBottom: 12 }}>How it works</h3>
        <div className="grid gap-3 text-sm text-text-secondary" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div>
            <div className="font-semibold text-text-primary" style={{ marginBottom: 4 }}>1. Customer sends file</div>
            Sends a JPG, PNG, PDF, or DOCX to your WhatsApp number from their phone.
          </div>
          <div>
            <div className="font-semibold text-text-primary" style={{ marginBottom: 4 }}>2. Auto-import</div>
            File is downloaded, deduplicated by SHA-256 hash, and saved to <code>media-center/incoming/</code>.
          </div>
          <div>
            <div className="font-semibold text-text-primary" style={{ marginBottom: 4 }}>3. Appear in dashboard</div>
            Card appears in <b>Incoming</b>. Open it → pick a preset → the CTA processes it, then turns into Print.
          </div>
        </div>
      </div>
    </div>
  );
}
