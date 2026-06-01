'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { api } from '@/lib/api';

// Network/connection indicator for the top-right of the nav. Combines the
// browser's own online state with a live ping to the backend health endpoint,
// so the operator can tell at a glance whether files can still flow in.
export function NetworkStatus() {
  const [browserOnline, setBrowserOnline] = useState(true);

  useEffect(() => {
    setBrowserOnline(navigator.onLine);
    const on = () => setBrowserOnline(true);
    const off = () => setBrowserOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const { data, error } = useSWR('/health', api.fetcher, {
    refreshInterval: 5000,
    revalidateOnFocus: false,
    shouldRetryOnError: true,
    dedupingInterval: 2000,
  });

  const serverUp = !error && !!data?.ok;
  const online = browserOnline && serverUp;
  const tone = online ? 'green' : 'pink';
  const label = !browserOnline ? 'Offline' : serverUp ? 'Online' : 'No server';

  const bg = {
    green: 'var(--color-tag-green-bg)',
    pink: 'var(--color-tag-pink-bg)',
  }[tone];
  const fg = {
    green: 'var(--color-tag-green-text)',
    pink: 'var(--color-tag-pink-text)',
  }[tone];

  return (
    <span
      className="inline-flex items-center gap-2 rounded-pill text-xs font-semibold"
      style={{ padding: '6px 12px', background: bg, color: fg }}
      title={online ? 'Connected to print server' : 'Connection lost — files may not arrive'}
    >
      <span style={{ position: 'relative', width: 8, height: 8, display: 'inline-flex' }}>
        {online && (
          <span
            className="status-pulse"
            style={{ width: 8, height: 8, border: `2px solid ${fg}`, top: 0, left: 0 }}
          />
        )}
        <span
          style={{ width: 8, height: 8, borderRadius: 999, background: fg, display: 'inline-block' }}
        />
      </span>
      {label}
    </span>
  );
}
