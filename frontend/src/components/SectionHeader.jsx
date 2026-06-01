export function SectionHeader({ title, count, actions, compact = false }) {
  return (
    <div className="flex items-center justify-between" style={{ marginBottom: compact ? 6 : 12 }}>
      <div className="flex items-baseline gap-2">
        <h2 className="font-bold tracking-tight" style={{ fontSize: 18, color: 'var(--color-text-primary)' }}>
          {title}
        </h2>
        {count != null && (
          <span style={{ fontSize: 18, fontWeight: 400, color: 'var(--color-text-secondary)' }}>
            {count}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-text-secondary">
        {actions || (
          <>
            <button aria-label="filter" className="hover:text-text-primary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18M6 12h12M10 18h4" />
              </svg>
            </button>
            <button aria-label="more" className="hover:text-text-primary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
