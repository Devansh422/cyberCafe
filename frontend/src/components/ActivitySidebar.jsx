
'use client';
import useSWR from 'swr';
import { api } from '@/lib/api';
import { Avatar } from './Avatar';
import { StatusTimeline } from './StatusTimeline';
import { fmtTimeAgo, fmtClock } from '@/lib/format';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getWeek() {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function CalendarWeek() {
  const today = new Date();
  const week = getWeek();
  const first = week[0];
  const last = week[6];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const range = `${MONTHS[first.getMonth()]} ${first.getDate()}–${last.getDate()}`;

  return (
    <>
      <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
        <h2 className="font-bold" style={{ fontSize: 20 }}>Activity</h2>
        <div className="flex items-center gap-2 text-text-secondary text-sm">
          <button aria-label="prev">‹</button>
          <span>{range}</span>
          <button aria-label="next">›</button>
        </div>
      </div>
      <div
        className="grid text-center"
        style={{ gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: 16 }}
      >
        {week.map((d, i) => {
          const active = d.toDateString() === today.toDateString();
          return (
            <div key={i} className="flex flex-col items-center" style={{ gap: 4 }}>
              <span
                className="font-medium uppercase"
                style={{
                  fontSize: 11,
                  letterSpacing: '0.04em',
                  color: 'var(--color-cal-inactive-fg)',
                }}
              >
                {DAY_LABELS[d.getDay()]}
              </span>
              <span
                className="flex items-center justify-center rounded-pill"
                style={{
                  width: 28,
                  height: 28,
                  fontSize: 12,
                  fontWeight: active ? 700 : 500,
                  background: active ? 'var(--color-cal-active-bg)' : 'transparent',
                  color: active ? 'var(--color-cal-active-fg)' : 'var(--color-text-secondary)',
                }}
              >
                {d.getDate()}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ActivityItem({ entry }) {
  return (
    <div
      className="flex items-center gap-3"
      style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}
    >
      <Avatar name={entry.customer_name || entry.filename || '?'} size={36} />
      <div className="flex-1 min-w-0">
        <div
          className="text-sm font-medium"
          style={{
            color: 'var(--color-text-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.detail || entry.filename || entry.event}
        </div>
        <div className="text-xs" style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>
          {fmtClock(entry.created_at)} · {fmtTimeAgo(entry.created_at)}
        </div>
      </div>
      {entry.status && (
        <StatusTimeline status={entry.status} compact />
      )}
    </div>
  );
}

function PremiumCard() {
  return (
    <div
      style={{
        background: 'var(--color-premium-bg)',
        borderRadius: 20,
        padding: 20,
        marginTop: 16,
      }}
    >
      <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
        <div
          className="rounded-pill flex items-center justify-center"
          style={{ width: 24, height: 24, background: 'var(--color-premium-fg)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#111" stroke="none">
            <path d="M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z" />
          </svg>
        </div>
        <span className="font-bold" style={{ fontSize: 18, color: 'var(--color-premium-fg)' }}>
          Ratan Pro
        </span>
      </div>
      <p
        style={{
          fontSize: 12,
          color: 'rgba(255,255,255,0.65)',
          marginBottom: 16,
          lineHeight: 1.6,
        }}
      >
        Unlock OCR, customer portal, multi-shop sync and analytics.
      </p>
      <button
        className="flex items-center justify-between rounded-pill font-semibold"
        style={{
          background: 'var(--color-premium-btn-bg)',
          color: 'var(--color-premium-btn-fg)',
          padding: '10px 16px',
          fontSize: 14,
          width: '100%',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <span>$9.99/month</span>
        <span>→</span>
      </button>
    </div>
  );
}

export function ActivitySidebar() {
  const { data } = useSWR('/system/activity?limit=8', api.fetcher, { refreshInterval: 4000 });
  const items = Array.isArray(data) ? data : [];

  return (
    <aside
      className="overflow-y-auto"
      style={{
        background: 'var(--color-bg-sidebar)',
        padding: 20,
        borderLeft: '1px solid var(--color-border)',
        height: 'calc(100vh - 56px)',
      }}
    >
      <CalendarWeek />
      <div>
        {items.length === 0 && (
          <div className="text-sm text-text-secondary" style={{ padding: '8px 0' }}>
            No activity yet. Send a file on WhatsApp to get started.
          </div>
        )}
        {items.map((e) => (
          <ActivityItem key={e.id} entry={e} />
        ))}
      </div>
      <PremiumCard />
    </aside>
  );
}
