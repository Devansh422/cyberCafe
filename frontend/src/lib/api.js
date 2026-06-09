// In the Next dev server, `/api` is proxied to the Rust backend (:5000). In the
// Tauri static-export build there is no proxy, so NEXT_PUBLIC_API_BASE points
// the UI directly at the local backend (127.0.0.1 avoids localhost/IPv6
// resolution surprises in the packaged WebView). `fileUrl`/`passportPreviewUrl`
// below build on `base`, so they become absolute automatically in the packaged
// app.
const base = `${process.env.NEXT_PUBLIC_API_BASE || ''}/api`;

async function request(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${text || res.statusText}`);
  }
  return res.json();
}

export const api = {
  fetcher: (path) => request(path),
  listJobs: (status) => request(`/jobs${status ? `?status=${status}` : ''}`),
  getJob: (id) => request(`/jobs/${id}`),
  processJob: (id, preset = 'scan_pdf', signal) =>
    request(`/jobs/${id}/process`, { method: 'POST', body: JSON.stringify({ preset }), signal }),
  printJob: (id, opts = {}, signal) =>
    request(`/jobs/${id}/print`, { method: 'POST', body: JSON.stringify(opts), signal }),
  deleteJob: (id) => request(`/jobs/${id}`, { method: 'DELETE' }),
  // Copy the job's file into the OS Downloads folder under a readable name.
  saveJob: (id) => request(`/jobs/${id}/save`, { method: 'POST' }),
  clearJobs: (status) => request(`/jobs?status=${status}`, { method: 'DELETE' }),
  processBatch: (batchId, preset = 'scan_pdf', signal) =>
    request(`/jobs/batch/${batchId}/process`, { method: 'POST', body: JSON.stringify({ preset }), signal }),
  printBatch: (batchId, opts = {}, signal) =>
    request(`/jobs/batch/${batchId}/print`, { method: 'POST', body: JSON.stringify(opts), signal }),
  // Immediately stop work: clears the print queue, kills the print engine, and
  // resets anything stuck mid-print. Backs the "Kill process" buttons.
  cancelProcessing: () => request('/system/cancel', { method: 'POST' }),
  deleteBatch: (batchId) => request(`/jobs/batch/${batchId}`, { method: 'DELETE' }),
  mergeJobs: (ids, preset = 'scan_pdf') =>
    request('/jobs/merge', { method: 'POST', body: JSON.stringify({ ids, preset }) }),
  // Compose two photos onto one A4 page (horizontal | vertical) for ID prints.
  // items: [{ id, zoom, panX, panY }, …] (exactly 2).
  makeCollage: (layout, items) =>
    request('/jobs/collage', { method: 'POST', body: JSON.stringify({ layout, items }) }),
  health: () => request('/health'),
  status: () => request('/system/status'),
  qr: () => request('/system/whatsapp/qr'),
  startWhatsapp: () => request('/system/whatsapp/start', { method: 'POST' }),
  // Unlink the current WhatsApp number and show a fresh QR for a different one.
  logoutWhatsapp: () => request('/system/whatsapp/logout', { method: 'POST' }),
  // force=true re-enumerates connected printers past the backend's 30s cache.
  printers: (force = false) => request(`/system/printers${force ? '?force=1' : ''}`),
  activity: (limit = 25) => request(`/system/activity?limit=${limit}`),
  diagnostics: () => request('/system/diagnostics'),
  // ---- Passport pipeline ----
  passportStatus: () => request('/passport/status'),
  preparePassport: async (file, bg, signal) => {
    const fd = new FormData();
    fd.append('file', file);
    if (bg) fd.append('bg', bg);
    const res = await fetch(`${base}/passport/prepare`, { method: 'POST', body: fd, signal });
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || res.statusText);
    return res.json();
  },
  preparePassportFromJob: (jobId, bg, signal) =>
    request('/passport/prepare-job', { method: 'POST', body: JSON.stringify({ jobId, bg }), signal }),
  createPassportSheet: (items, bg, signal) =>
    request('/passport/sheet', { method: 'POST', body: JSON.stringify({ items, bg }), signal }),
};

export const passportPreviewUrl = (id) => `${base}/passport/prepared/${id}`;

export const fileUrl = (id, processed = false) =>
  `${base}/jobs/${id}/file${processed ? '?processed=1' : ''}`;
