'use client';
// Shared updater state for the whole app. Provides:
//   • an automatic check on launch (surfaces the install card if an update is
//     ready), and
//   • a manual `checkNow()` used by the "Check for updates" button in the nav,
//     so a user who dismissed the popup can still pull the update on demand.
// Outside the Tauri desktop app (e.g. `next dev` in a browser) it's inert.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const UpdateCtx = createContext(null);
export function useUpdate() { return useContext(UpdateCtx); }

function inTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

export function UpdateProvider({ children }) {
  // Card state (an actual update is available / installing / failed installing).
  const [phase, setPhase] = useState('idle'); // idle | available | downloading | error
  const [info, setInfo] = useState(null); // { version, body }
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState(null);
  // Button feedback for a manual check.
  const [checkState, setCheckState] = useState('idle'); // idle | checking | uptodate | failed

  const updateRef = useRef(null); // the live Update object
  const busy = useRef(false);
  const flashTimer = useRef(null);

  const flash = useCallback((s) => {
    setCheckState(s);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setCheckState('idle'), 4000);
  }, []);

  const checkNow = useCallback(async (manual = false) => {
    if (busy.current) return;
    busy.current = true;
    if (manual) setCheckState('checking');
    try {
      if (!inTauri()) { if (manual) flash('uptodate'); return; }
      const { check } = await import('@tauri-apps/plugin-updater');
      const found = await check();
      if (found && found.available) {
        updateRef.current = found;
        setInfo({ version: found.version, body: found.body });
        setPhase('available');
        setCheckState('idle');
      } else if (manual) {
        flash('uptodate');
      }
    } catch (e) {
      const m = e?.message || String(e);
      if (manual) { setErr(m); flash('failed'); }
      else console.warn('[updater] check failed:', m); // auto-check stays quiet
    } finally {
      busy.current = false;
    }
  }, [flash]);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setErr(null);
    setPhase('downloading');
    setPct(0);
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data?.contentLength || 0;
        else if (event.event === 'Progress') {
          got += event.data?.chunkLength || 0;
          if (total) setPct(Math.min(100, Math.round((got / total) * 100)));
        } else if (event.event === 'Finished') setPct(100);
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      setErr(String(e?.message || e));
      setPhase('error');
    }
  }, []);

  const dismiss = useCallback(() => setPhase('idle'), []);

  // Check once on launch.
  useEffect(() => { checkNow(false); }, [checkNow]);

  return (
    <UpdateCtx.Provider value={{ phase, info, pct, err, checkState, checkNow, install, dismiss }}>
      {children}
    </UpdateCtx.Provider>
  );
}
