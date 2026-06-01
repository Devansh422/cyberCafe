'use client';

// A small inline loader for buttons. Sized in px so it sits inline with text or
// an icon without forcing a full-page loading state (the UI stays interactive).
export function Spinner({ size = 14, color = 'currentColor', thickness = 2 }) {
  return (
    <span
      role="status"
      aria-label="loading"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: `${thickness}px solid ${color}`,
        borderTopColor: 'transparent',
        borderRadius: '999px',
        animation: 'spin 0.6s linear infinite',
        flexShrink: 0,
      }}
    />
  );
}
