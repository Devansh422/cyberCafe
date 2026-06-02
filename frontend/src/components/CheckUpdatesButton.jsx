'use client';
// Top-nav "Check for updates" button. Triggers a manual updater check; if an
// update is found the UpdateNotifier card appears, otherwise the button briefly
// confirms you're up to date (or that the check failed). Lets a user who
// dismissed the launch popup pull the update on demand.
import { useUpdate } from './UpdateContext';

const LABEL = {
  idle: 'Check for updates',
  checking: 'Checking…',
  uptodate: 'Up to date ✓',
  failed: 'Check failed',
};

export function CheckUpdatesButton() {
  const ctx = useUpdate();
  if (!ctx) return null;
  const { checkState, checkNow } = ctx;

  const tone =
    checkState === 'uptodate' ? 'var(--color-tag-green-text)' :
    checkState === 'failed' ? 'var(--color-tag-pink-text)' :
    'var(--color-text-secondary)';

  return (
    <button
      onClick={() => checkNow(true)}
      disabled={checkState === 'checking'}
      title="Check for app updates"
      className="inline-flex items-center gap-1.5 rounded-pill text-xs font-semibold"
      style={{
        padding: '6px 12px',
        background: 'transparent',
        color: tone,
        border: `1px solid ${checkState === 'idle' || checkState === 'checking' ? 'var(--color-border)' : tone}`,
        cursor: checkState === 'checking' ? 'wait' : 'pointer',
      }}
    >
      <svg
        width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        style={checkState === 'checking' ? { animation: 'spin 0.9s linear infinite' } : undefined}
      >
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 3v6h-6" />
      </svg>
      {LABEL[checkState] || LABEL.idle}
    </button>
  );
}
