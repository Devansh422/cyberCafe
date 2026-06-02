'use client';
// Auto-update prompt. On launch (inside the Tauri desktop app only) this asks
// the updater whether a newer signed release is published; if so it shows a
// card offering to install it. On confirm it downloads, installs, and relaunches
// the app. Outside Tauri (e.g. `next dev` in a browser) it renders nothing.
import { useEffect, useState } from 'react';

function inTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

export function UpdateNotifier() {
  const [update, setUpdate] = useState(null);
  const [info, setInfo] = useState(null); // { version, body }
  const [phase, setPhase] = useState('idle'); // idle | available | downloading | error
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!inTauri()) return; // running in a plain browser — nothing to update
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const found = await check();
        if (!cancelled && found && found.available) {
          setUpdate(found);
          setInfo({ version: found.version, body: found.body });
          setPhase('available');
        }
      } catch (e) {
        // Offline, no published release yet, or signature mismatch — stay quiet
        // so a failed check never blocks the app.
        console.warn('[updater] check failed:', e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function install() {
    if (!update) return;
    setErr(null);
    setPhase('downloading');
    setPct(0);
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data?.contentLength || 0;
        } else if (event.event === 'Progress') {
          got += event.data?.chunkLength || 0;
          if (total) setPct(Math.min(100, Math.round((got / total) * 100)));
        } else if (event.event === 'Finished') {
          setPct(100);
        }
      });
      // Installer applied — relaunch into the new version.
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      setErr(String(e?.message || e));
      setPhase('error');
    }
  }

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
            onClick={() => setPhase('idle')}
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
