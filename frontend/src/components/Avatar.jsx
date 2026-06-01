const PALETTE = ['#B03030', '#7A5A00', '#1A6B44', '#111111', '#4A4A4A', '#6B4226'];

function hash(str = '') {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({ name, size = 28, single = false }) {
  const initials = (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';

  const color = PALETTE[hash(name || '') % PALETTE.length];
  return (
    <div
      title={name || ''}
      className={`rounded-pill flex items-center justify-center text-brand-fg font-semibold ${single ? '' : ''}`}
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: Math.max(10, Math.floor(size * 0.4)),
        border: '2px solid var(--color-bg-surface)',
      }}
    >
      {initials}
    </div>
  );
}
