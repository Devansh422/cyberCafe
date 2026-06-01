'use client';
import { useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  Upload, Plus, Minus, X, Trash2, AlertTriangle, Printer,
  Loader2, Sparkles, Image as ImageIcon, CheckCircle2, MessageCircle, Ban,
} from 'lucide-react';
import { api, passportPreviewUrl } from '@/lib/api';
import { ProcessModal } from '@/components/ProcessModal';
import { PassportSourceModal } from '@/components/PassportSourceModal';
import { Spinner } from '@/components/Spinner';

const MAX_SLOTS = 9; // 3 per row × 3 rows on the 4"×6" sheet

const BG_OPTIONS = [
  { id: 'light-blue', label: 'Light blue', swatch: '#c9ddee' },
  { id: 'white', label: 'White', swatch: '#ffffff' },
  { id: 'light-grey', label: 'Light grey', swatch: '#e9ecef' },
  { id: 'red', label: 'Red', swatch: '#d23b3b' },
];

let localSeq = 0;

// A 4"×6" portrait preview of the sheet. Cells are 4:3 (wider than tall), 3 per
// row, filled top-down; leftover space at the bottom is left blank — mirroring
// what actually prints.
function SheetPreview({ slots }) {
  const margin = '3.2%';
  // Cells are 3:4 portrait (taller than wide), matching the print spec.
  return (
    <div
      style={{
        width: '100%',
        maxWidth: 280,
        aspectRatio: '4 / 6',
        background: '#fff',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-card)',
        padding: margin,
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '2.4%',
        alignContent: 'start',
        gridAutoRows: 'min-content',
      }}
    >
      {Array.from({ length: MAX_SLOTS }).map((_, i) => {
        const url = slots[i];
        return (
          <div
            key={i}
            style={{
              aspectRatio: '3 / 4',
              borderRadius: 3,
              overflow: 'hidden',
              background: url ? 'transparent' : 'var(--color-bg-overlay)',
              border: url ? '1px solid rgba(0,0,0,0.12)' : '1px dashed var(--color-border-dashed)',
            }}
          >
            {url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function PassportPage() {
  const { data: status } = useSWR('/passport/status', api.fetcher, { refreshInterval: 15000 });
  const [bg, setBg] = useState('light-blue');
  // Each entry sources from either an uploaded `file` OR a WhatsApp `jobId`.
  const [photos, setPhotos] = useState([]); // { uid, name, file?, jobId?, id, previewUrl, matted, preparing, copies, error }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sheetJob, setSheetJob] = useState(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const fileRef = useRef(null);
  const abortRef = useRef(null); // AbortController for the in-flight prepare/build

  const matteOffline = status && status.ready === false;

  // Expand photos → ordered preview urls (repeat per copies, cap at 9).
  const filledSlots = useMemo(() => {
    const out = [];
    for (const p of photos) {
      if (!p.previewUrl) continue;
      for (let i = 0; i < p.copies && out.length < MAX_SLOTS; i++) out.push(p.previewUrl);
    }
    return out;
  }, [photos]);

  const totalRequested = photos.reduce((n, p) => n + (p.previewUrl ? p.copies : 0), 0);
  const readyPhotos = photos.filter((p) => p.id && !p.preparing);
  const anyPreparing = photos.some((p) => p.preparing);

  // Run MODNet on an entry, sourcing from its uploaded file or its WhatsApp job.
  async function prepareEntry(entry, useBg, signal) {
    if (entry.file) return api.preparePassport(entry.file, useBg, signal);
    return api.preparePassportFromJob(entry.jobId, useBg, signal);
  }

  async function runPrepare(entries, useBg) {
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      for (const entry of entries) {
        if (controller.signal.aborted) break;
        try {
          const res = await prepareEntry(entry, useBg, controller.signal);
          setPhotos((prev) => prev.map((p) =>
            p.uid === entry.uid
              ? { ...p, id: res.id, previewUrl: passportPreviewUrl(res.id), matted: res.matted, subjectFound: res.subjectFound, faceDetected: res.faceDetected, preparing: false, error: null }
              : p));
        } catch (e) {
          const cancelled = e.name === 'AbortError';
          setPhotos((prev) => prev.map((p) =>
            p.uid === entry.uid ? { ...p, preparing: false, error: cancelled ? 'Cancelled' : e.message } : p));
          if (cancelled) break; // stop the whole batch, not just this entry
        }
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  // Immediately stop preparing/building: abort the in-flight request, clear any
  // "preparing" spinners, and have the backend kill the print engine too.
  async function killProcess() {
    abortRef.current?.abort();
    setBusy(false);
    setPhotos((prev) => prev.map((p) => (p.preparing ? { ...p, preparing: false, error: 'Cancelled' } : p)));
    try { await api.cancelProcessing(); } catch { /* best effort */ }
  }

  async function onFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setErr(null);
    const seeded = files.map((file) => ({
      uid: ++localSeq, name: file.name, file, id: null, previewUrl: null, matted: null, preparing: true, copies: 1, error: null,
    }));
    setPhotos((prev) => [...prev, ...seeded]);
    await runPrepare(seeded, bg);
    if (fileRef.current) fileRef.current.value = '';
  }

  // Pull selected WhatsApp incoming images in as passport sources.
  async function addFromJobs(jobIds) {
    setSourceOpen(false);
    if (!jobIds?.length) return;
    setErr(null);
    const seeded = jobIds.map((jobId) => ({
      uid: ++localSeq, name: `WhatsApp #${jobId}`, jobId, id: null, previewUrl: null, matted: null, preparing: true, copies: 1, error: null,
    }));
    setPhotos((prev) => [...prev, ...seeded]);
    await runPrepare(seeded, bg);
  }

  // Changing the background re-runs removal on every photo with the new colour.
  async function changeBg(next) {
    if (next === bg) return;
    setBg(next);
    const targets = photos.filter((p) => p.file || p.jobId);
    if (!targets.length) return;
    setPhotos((prev) => prev.map((p) => ((p.file || p.jobId) ? { ...p, preparing: true } : p)));
    await runPrepare(targets, next);
  }

  function setCopies(uid, delta) {
    setPhotos((prev) => prev.map((p) =>
      p.uid === uid ? { ...p, copies: Math.max(1, Math.min(MAX_SLOTS, p.copies + delta)) } : p));
  }
  function removePhoto(uid) {
    setPhotos((prev) => prev.filter((p) => p.uid !== uid));
  }
  function fillNine() {
    // Convenience: a single photo → 9 copies (a full sheet of the same photo).
    if (readyPhotos.length === 1) {
      setPhotos((prev) => prev.map((p) => (p.id ? { ...p, copies: MAX_SLOTS } : p)));
    }
  }

  async function createSheet() {
    if (!readyPhotos.length || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setErr(null);
    try {
      const items = readyPhotos.map((p) => ({ id: p.id, copies: p.copies }));
      const job = await api.createPassportSheet(items, bg, controller.signal);
      setSheetJob(job);
    } catch (e) {
      setErr(e.name === 'AbortError' ? 'Cancelled' : e.message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" style={{ height: '100%', minHeight: 0 }}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-bold tracking-tight" style={{ fontSize: 28, letterSpacing: '-0.02em' }}>
            Passport Photos
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            Detects & centres the face, removes the background, crops to 3:4 — then tiles 9 (3×3) onto a 4"×6" sheet ready to print.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {status && (
            <span
              className="inline-flex items-center gap-1.5 rounded-pill font-semibold"
              style={{
                padding: '5px 12px',
                background: status.ready ? 'var(--color-tag-green-bg)' : 'var(--color-tag-yellow-bg)',
                color: status.ready ? 'var(--color-tag-green-text)' : 'var(--color-tag-yellow-text)',
              }}
            >
              {status.ready ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
              MODNet {status.ready ? 'ready' : 'offline'}
            </span>
          )}
        </div>
      </div>

      {matteOffline && (
        <div
          className="flex items-start gap-3 text-sm"
          style={{
            background: 'var(--color-tag-yellow-bg)',
            color: 'var(--color-tag-yellow-text)',
            border: '1px solid var(--color-tag-yellow-text)',
            borderRadius: 12,
            padding: '12px 14px',
          }}
        >
          <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <b>Background removal is offline.</b> Photos will still tile onto the sheet, but their
            backgrounds won't be replaced. Add the MODNet ONNX model at{' '}
            <code>MODNet/pretrained/modnet.onnx</code> (or set <code>MODNET_ONNX</code>) and restart the backend.
            {status?.ortLoaded === false && ' onnxruntime-node is not installed.'}
          </div>
        </div>
      )}

      <div className="grid gap-6" style={{ gridTemplateColumns: '1.5fr 1fr', minHeight: 0, height: '100%' }}>
        {/* Left: controls + photo list */}
        <section className="flex flex-col gap-4" style={{ minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
          {/* Background picker */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Background</span>
            <div className="flex flex-wrap gap-2">
              {BG_OPTIONS.map((o) => {
                const active = bg === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => changeBg(o.id)}
                    className="flex items-center gap-2 text-xs font-medium rounded-pill"
                    style={{
                      padding: '7px 12px',
                      background: active ? 'var(--color-brand)' : 'var(--color-bg-overlay)',
                      color: active ? 'var(--color-brand-fg)' : 'var(--color-text-secondary)',
                      border: '1px solid',
                      borderColor: active ? 'var(--color-brand)' : 'var(--color-border)',
                    }}
                  >
                    <span style={{ width: 14, height: 14, borderRadius: 999, background: o.swatch, border: '1px solid rgba(0,0,0,0.15)' }} />
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Sources: upload from disk OR pull from WhatsApp incoming */}
          <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex flex-col items-center justify-center gap-2 text-text-muted hover:text-text-secondary transition-colors"
              style={{
                background: 'var(--color-bg-surface)',
                border: '1.5px dashed var(--color-border-dashed)',
                borderRadius: 16,
                padding: 20,
                cursor: 'pointer',
              }}
            >
              <Upload size={20} />
              <span className="text-sm font-medium text-text-primary">Upload photos</span>
              <span className="text-xs">JPG / PNG · several ok</span>
            </button>
            <button
              type="button"
              onClick={() => setSourceOpen(true)}
              className="flex flex-col items-center justify-center gap-2 transition-colors"
              style={{
                background: 'var(--color-bg-surface)',
                border: '1.5px dashed var(--color-border-dashed)',
                borderRadius: 16,
                padding: 20,
                cursor: 'pointer',
                color: 'var(--color-text-secondary)',
              }}
            >
              <MessageCircle size={20} style={{ color: '#25D366' }} />
              <span className="text-sm font-medium text-text-primary">Add from WhatsApp</span>
              <span className="text-xs">incoming photos</span>
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".jpg,.jpeg,.png"
            multiple
            onChange={(e) => onFiles(e.target.files)}
            style={{ display: 'none' }}
          />

          {/* Prepared photos */}
          {photos.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                  Photos ({readyPhotos.length})
                </span>
                {readyPhotos.length === 1 && (
                  <button
                    type="button"
                    onClick={fillNine}
                    className="text-xs font-semibold rounded-pill"
                    style={{ padding: '4px 10px', background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
                  >
                    Fill all 9 with this
                  </button>
                )}
              </div>
              {photos.map((p) => (
                <div
                  key={p.uid}
                  className="flex items-center gap-3"
                  style={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 10 }}
                >
                  <div
                    style={{ width: 64, height: 48, borderRadius: 6, overflow: 'hidden', background: 'var(--color-bg-overlay)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    {p.preparing ? (
                      <Loader2 size={16} className="lucide-spin" />
                    ) : p.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <ImageIcon size={16} />
                    )}
                  </div>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-medium flex items-center gap-1.5" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.jobId && <MessageCircle size={12} style={{ color: '#25D366', flexShrink: 0 }} />}
                      {p.name || 'photo'}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {p.preparing
                        ? 'Detecting face · removing background…'
                        : p.error
                        ? <span style={{ color: 'var(--color-tag-pink-text)' }}>{p.error}</span>
                        : p.subjectFound === false
                        ? <span style={{ color: 'var(--color-tag-pink-text)' }}>No person detected — not a portrait?</span>
                        : p.matted === false
                        ? 'Tiled as-is (MODNet offline)'
                        : p.faceDetected === false
                        ? <span style={{ color: 'var(--color-tag-yellow-text)' }}>No face found · centred crop</span>
                        : 'Face centred · bg removed'}
                    </span>
                  </div>

                  {/* Copies stepper */}
                  <div className="flex items-center gap-1" style={{ background: 'var(--color-bg-overlay)', borderRadius: 999, padding: 3 }}>
                    <button type="button" onClick={() => setCopies(p.uid, -1)} disabled={p.copies <= 1}
                      className="flex items-center justify-center rounded-pill"
                      style={{ width: 26, height: 26, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', cursor: 'pointer' }}>
                      <Minus size={13} />
                    </button>
                    <span className="text-sm font-semibold" style={{ width: 22, textAlign: 'center' }}>{p.copies}</span>
                    <button type="button" onClick={() => setCopies(p.uid, +1)} disabled={p.copies >= MAX_SLOTS}
                      className="flex items-center justify-center rounded-pill"
                      style={{ width: 26, height: 26, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', cursor: 'pointer' }}>
                      <Plus size={13} />
                    </button>
                  </div>

                  <button
                    type="button"
                    aria-label="Remove"
                    onClick={() => removePhoto(p.uid)}
                    className="flex items-center justify-center rounded-pill"
                    style={{ width: 30, height: 30, background: 'var(--color-tag-pink-bg)', color: 'var(--color-tag-pink-text)', border: '1px solid var(--color-tag-pink-text)', flexShrink: 0 }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Right: live sheet preview + create */}
        <section className="flex flex-col gap-3 items-center" style={{ minHeight: 0, overflowY: 'auto' }}>
          <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide self-start">
            Sheet preview · 4"×6"
          </span>
          <SheetPreview slots={filledSlots} />

          <div className="flex items-center gap-2 text-sm">
            <span
              className="rounded-pill font-semibold"
              style={{
                padding: '4px 12px',
                background: totalRequested > MAX_SLOTS ? 'var(--color-tag-yellow-bg)' : 'var(--color-bg-overlay)',
                color: totalRequested > MAX_SLOTS ? 'var(--color-tag-yellow-text)' : 'var(--color-text-secondary)',
              }}
            >
              {Math.min(filledSlots.length, MAX_SLOTS)} / {MAX_SLOTS} slots
            </span>
          </div>
          {totalRequested > MAX_SLOTS && (
            <span className="text-xs text-text-secondary text-center">
              Only the first {MAX_SLOTS} will be placed on the sheet.
            </span>
          )}

          {err && <div className="text-xs" style={{ color: 'var(--color-tag-pink-text)' }}>{err}</div>}

          <button
            type="button"
            onClick={createSheet}
            disabled={!readyPhotos.length || busy || anyPreparing}
            className="flex items-center justify-center gap-2 text-sm font-semibold rounded-pill w-full"
            style={{
              padding: '13px 16px',
              background: 'var(--color-brand)',
              color: 'var(--color-brand-fg)',
              border: 'none',
              maxWidth: 280,
              cursor: !readyPhotos.length || busy || anyPreparing ? 'not-allowed' : 'pointer',
              opacity: !readyPhotos.length || busy || anyPreparing ? 0.6 : 1,
            }}
          >
            {busy ? <Spinner size={16} color="var(--color-brand-fg)" /> : <Printer size={16} />}
            {busy ? 'Building sheet…' : 'Create print sheet'}
          </button>

          {/* Kill switch — only while preparing photos or building the sheet.
              Aborts the in-flight request and stops the run at once. */}
          {(busy || anyPreparing) && (
            <button
              type="button"
              onClick={killProcess}
              className="flex items-center justify-center gap-2 text-sm font-semibold rounded-pill w-full"
              style={{
                padding: '11px 16px',
                maxWidth: 280,
                background: 'var(--color-tag-pink-bg)',
                color: 'var(--color-tag-pink-text)',
                border: '1px solid var(--color-tag-pink-text)',
                cursor: 'pointer',
              }}
            >
              <Ban size={15} /> Kill process
            </button>
          )}
          {anyPreparing && (
            <span className="text-xs text-text-secondary flex items-center gap-1.5">
              <Sparkles size={12} /> Preparing photos…
            </span>
          )}
        </section>
      </div>

      {/* After building, drop into the print popup for the new sheet. */}
      {sheetJob && (
        <ProcessModal
          ids={[sheetJob.id]}
          initialJobs={[sheetJob]}
          onClose={() => setSheetJob(null)}
          onChange={async () => {}}
        />
      )}

      {sourceOpen && (
        <PassportSourceModal
          onClose={() => setSourceOpen(false)}
          onConfirm={addFromJobs}
        />
      )}
    </div>
  );
}
