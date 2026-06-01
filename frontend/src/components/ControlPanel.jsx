'use client';
import { useRef, useState } from 'react';
import useSWR from 'swr';
import { Sparkles, Printer, Layers, Wand2, Ban } from 'lucide-react';
import { api } from '@/lib/api';
import { Spinner } from './Spinner';

const PRESETS = [
  { id: 'scan_pdf', label: 'Scan PDF' },
  { id: 'bw', label: 'Black & White' },
  { id: 'color', label: 'Color' },
  { id: 'high_contrast', label: 'High Contrast' },
  { id: 'a4_resize', label: 'A4 Resize' },
];

const LABEL = 'text-xs font-semibold text-text-secondary uppercase tracking-wide';

// A job is printable only once it's been rendered to a PDF.
const PRINTABLE = new Set(['processed', 'printing', 'printed']);

// Full processing controls — presets, printer, copies — driven by a single
// status-aware CTA: it reads "Process" while any item still needs rendering,
// then flips to "Print" once everything is a printable PDF. Drives a single job
// or a whole batch. Lives on the right side of the Process modal. A failed/busy
// action never freezes the page: every action runs through a local `busy` flag
// that only disables this panel.
export function ControlPanel({ jobs = [], batchId = null, onChange, onClose }) {
  const [preset, setPreset] = useState(jobs[0]?.preset || 'high_contrast');
  const [printer, setPrinter] = useState('');
  const [copies, setCopies] = useState(1);
  const [grayscale, setGrayscale] = useState(false);
  const [busy, setBusy] = useState(null); // 'process' | 'print' | null
  const [err, setErr] = useState(null);
  const abortRef = useRef(null); // AbortController for the in-flight action

  const { data: printers } = useSWR('/system/printers', api.fetcher, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    dedupingInterval: 60_000,
  });

  const isBatch = !!batchId && jobs.length > 1;
  const count = jobs.length;
  const disabled = !!busy || count === 0;

  // The CTA's mode is decided by the items themselves: until every one is a
  // printable PDF we're in "process" mode; after that we're in "print" mode.
  const allPrintable = count > 0 && jobs.every((j) => PRINTABLE.has(j.status));
  const pendingCount = jobs.filter((j) => !PRINTABLE.has(j.status)).length;
  const mode = allPrintable ? 'print' : 'process';

  async function run(kind, fn) {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(kind);
    setErr(null);
    try {
      await fn(controller.signal);
      await onChange?.();
    } catch (e) {
      // A kill aborts the request — show it as cancelled, not as a failure.
      setErr(e.name === 'AbortError' ? 'Cancelled' : e.message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(null);
    }
  }

  // Immediately stop the running action: abort the in-flight request so the UI
  // frees up at once, then tell the backend to clear the print queue and kill
  // the print engine.
  async function kill() {
    abortRef.current?.abort();
    try { await api.cancelProcessing(); } catch { /* best effort */ }
    await onChange?.();
  }

  function doProcess() {
    run('process', async (signal) => {
      if (isBatch) {
        await api.processBatch(batchId, preset, signal);
      } else {
        // Only render the items that still need it; leave processed ones alone.
        for (const j of jobs) {
          if (!PRINTABLE.has(j.status)) await api.processJob(j.id, preset, signal);
        }
      }
    });
  }

  function doPrint() {
    const opts = { preset, printer: printer || null, copies, grayscale };
    run('print', async (signal) => {
      if (isBatch) {
        await api.printBatch(batchId, opts, signal);
      } else {
        for (const j of jobs) await api.printJob(j.id, opts, signal);
      }
    });
  }

  // Re-render an already-processed item (e.g. after changing the preset),
  // overriding the "print" mode the status would otherwise force.
  function doReprocess() {
    run('process', async (signal) => {
      if (isBatch) {
        await api.processBatch(batchId, preset, signal);
      } else {
        for (const j of jobs) await api.processJob(j.id, preset, signal);
      }
    });
  }

  return (
    <div className="flex flex-col gap-5" style={{ height: '100%' }}>
      <div className="flex items-center gap-2">
        <Wand2 size={18} />
        <h3 className="font-bold" style={{ fontSize: 18 }}>Control Panel</h3>
        <span
          className="ml-auto text-xs font-semibold rounded-pill"
          style={{ padding: '3px 10px', background: 'var(--color-bg-overlay)', color: 'var(--color-text-secondary)' }}
        >
          {isBatch ? `Batch · ${count} items` : count > 1 ? `${count} items` : '1 item'}
        </span>
      </div>

      {/* Presets */}
      <div className="flex flex-col gap-2">
        <label className={`${LABEL} flex items-center gap-1.5`}>
          <Sparkles size={13} /> Preset
        </label>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => {
            const active = preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                disabled={disabled}
                onClick={() => setPreset(p.id)}
                className="text-xs font-medium rounded-pill"
                style={{
                  padding: '7px 14px',
                  background: active ? 'var(--color-brand)' : 'var(--color-bg-overlay)',
                  color: active ? 'var(--color-brand-fg)' : 'var(--color-text-secondary)',
                  border: '1px solid',
                  borderColor: active ? 'var(--color-brand)' : 'var(--color-border)',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Printer + copies */}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className={`${LABEL} flex items-center gap-1.5`}>
            <Printer size={13} /> Printer
          </label>
          <select
            value={printer}
            disabled={disabled}
            onChange={(e) => setPrinter(e.target.value)}
            className="w-full text-sm rounded-sm"
            style={{ padding: '8px 10px', background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)' }}
          >
            <option value="">Default</option>
            {(printers || []).map((p) => (
              <option key={p.name || p.deviceId} value={p.name}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={`${LABEL} flex items-center gap-1.5`}>
            <Layers size={13} /> Copies
          </label>
          <input
            type="number"
            min={1}
            value={copies}
            disabled={disabled}
            onChange={(e) => setCopies(Math.max(1, parseInt(e.target.value || '1', 10)))}
            className="w-full text-sm rounded-sm"
            style={{ padding: '8px 10px', background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)' }}
          />
        </div>
      </div>

      {/* Grayscale toggle */}
      <label
        className="flex items-center gap-2 text-sm select-none"
        style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        <input
          type="checkbox"
          checked={grayscale}
          disabled={disabled}
          onChange={(e) => setGrayscale(e.target.checked)}
        />
        Print in grayscale (monochrome)
      </label>

      {err && (
        <div className="text-xs" style={{ color: 'var(--color-tag-pink-text)' }}>{err}</div>
      )}

      {/* Status-aware CTA: "Process" until everything is a printable PDF, then
          "Print". A small Re-process link stays available once printable. */}
      <div className="flex flex-col gap-2 mt-auto">
        {mode === 'process' && pendingCount > 0 && count > 1 && (
          <span className="text-xs text-text-secondary text-center">
            {pendingCount} of {count} still need processing
          </span>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={mode === 'print' ? doPrint : doProcess}
          className="flex items-center justify-center gap-2 text-sm font-semibold rounded-pill"
          style={{
            padding: '13px 16px',
            background: 'var(--color-brand)',
            color: 'var(--color-brand-fg)',
            border: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.7 : 1,
          }}
        >
          {busy
            ? <Spinner size={16} color="var(--color-brand-fg)" />
            : mode === 'print' ? <Printer size={16} /> : <Sparkles size={16} />}
          {busy === 'process'
            ? 'Processing…'
            : busy === 'print'
            ? 'Sending to printer…'
            : mode === 'print'
            ? (isBatch ? 'Print Batch →' : 'Print →')
            : (isBatch ? 'Process Batch' : 'Process')}
        </button>

        {/* Kill switch — only while something is running. Aborts the request and
            kills the print engine on the backend. */}
        {busy && (
          <button
            type="button"
            onClick={kill}
            className="flex items-center justify-center gap-2 text-sm font-semibold rounded-pill"
            style={{
              padding: '11px 16px',
              background: 'var(--color-tag-pink-bg)',
              color: 'var(--color-tag-pink-text)',
              border: '1px solid var(--color-tag-pink-text)',
              cursor: 'pointer',
            }}
          >
            <Ban size={15} /> Kill process
          </button>
        )}

        {mode === 'print' && (
          <button
            type="button"
            disabled={disabled}
            onClick={doReprocess}
            className="flex items-center justify-center gap-2 text-xs font-medium rounded-pill"
            style={{
              padding: '8px 16px',
              background: 'var(--color-bg-overlay)',
              color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border)',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            <Sparkles size={13} /> Re-process with this preset
          </button>
        )}
      </div>
    </div>
  );
}
