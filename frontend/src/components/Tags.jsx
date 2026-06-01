export function DeptTag({ children, icon }) {
  return (
    <span
      className="inline-flex items-center gap-1 bg-dept-bg text-dept-fg font-semibold rounded-pill"
      style={{ fontSize: 11, padding: '3px 10px' }}
    >
      {icon && (
        <span
          className="rounded-xs bg-brand-fg"
          style={{ width: 12, height: 12, display: 'inline-block', borderRadius: 3, opacity: 0.85 }}
        />
      )}
      <span style={{ letterSpacing: '0.03em' }}>{children}</span>
    </span>
  );
}

const TONE_CLASS = {
  pink: 'bg-tag-pink-bg text-tag-pink-text',
  yellow: 'bg-tag-yellow-bg text-tag-yellow-text',
  green: 'bg-tag-green-bg text-tag-green-text',
};

export function DateBadge({ tone = 'green', children }) {
  return (
    <span
      className={`inline-flex items-center gap-1 font-medium rounded-pill ${TONE_CLASS[tone] || TONE_CLASS.green}`}
      style={{ fontSize: 11, padding: '3px 10px' }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" strokeLinecap="round" />
      </svg>
      {children}
    </span>
  );
}
