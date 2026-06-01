const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The backend mixes two timestamp formats:
//   • SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" — naive UTC, no zone marker.
//   • new Date().toISOString() → "...Z" — already zoned.
// `new Date("2026-05-31 12:34:56")` parses the naive form as LOCAL time, which
// pushed every activity timestamp off by the timezone offset. Normalize naive
// SQLite stamps to UTC (append 'Z') before constructing the Date so both forms
// resolve to the same instant.
export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    s = s.replace(' ', 'T') + 'Z';
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDateShort(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${DAYS[d.getDay()]}`;
}

export function fmtTimeAgo(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 0) return 'just now';
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return fmtDateShort(iso);
}

export function dateBadgeTone(iso) {
  const d = toDate(iso);
  if (!d) return 'green';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff > 24 * 3600) return 'pink';
  if (diff > 3600) return 'yellow';
  return 'green';
}

// Local clock time, e.g. "2:34 PM" — handy for activity rows.
export function fmtClock(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const STATUS_LABEL = {
  incoming: 'In queue',
  processed: 'Ready',
  queued: 'Queued',
  printing: 'Printing',
  printed: 'Completed',
  failed: 'Failed',
};

export const TYPE_LABEL = {
  image: 'IMAGE',
  pdf: 'PDF',
  docx: 'DOC',
  other: 'FILE',
};

export function progressPercent(status) {
  switch (status) {
    case 'incoming': return 25;
    case 'processed': return 70;
    case 'printing': return 90;
    case 'printed': return 100;
    case 'failed': return 0;
    default: return 0;
  }
}
