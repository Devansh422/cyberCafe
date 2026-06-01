const BASE_STEPS = [
  { key: 'incoming', label: 'Incoming' },
  { key: 'processed', label: 'Processed' },
  { key: 'printing', label: 'Printing' },
  { key: 'printed', label: 'Printed' },
];

const QUEUE_STEPS = [
  { key: 'incoming', label: 'Incoming' },
  { key: 'processed', label: 'Processed' },
  { key: 'queued', label: 'Queued' },
  { key: 'printing', label: 'Printing' },
  { key: 'printed', label: 'Printed' },
];

const FAILED_STEP = { key: 'failed', label: 'Failed', tone: 'pink' };

function getSteps({ status, currentKey, showQueued }) {
  const activeKey = currentKey || status;
  const useQueue = showQueued || activeKey === 'queued';
  const base = useQueue ? QUEUE_STEPS : BASE_STEPS;
  const isFailed = activeKey === 'failed' || status === 'failed';
  const steps = isFailed ? [...base, FAILED_STEP] : base;
  const activeIndex = steps.findIndex((step) => step.key === activeKey);
  return { steps, activeIndex };
}

export function StatusTimeline({ status, currentKey, showQueued = false, compact = false }) {
  if (!status && !currentKey) return null;

  const { steps, activeIndex } = getSteps({ status, currentKey, showQueued });
  const resolvedIndex = activeIndex >= 0 ? activeIndex : 0;
  const dotSize = compact ? 6 : 8;
  const labelSize = compact ? 9 : 11;
  const pulseSize = compact ? 14 : 18;
  const showPulse = !compact;
  const stepCount = steps.length;
  const edgePct = stepCount > 1 ? 100 / (stepCount * 2) : 0;
  const trackPct = 100 - edgePct * 2;
  const progressPct = stepCount > 1 ? (resolvedIndex / (stepCount - 1)) * trackPct : 0;
  const isFailed = steps[resolvedIndex]?.key === 'failed';
  const progressColor = isFailed ? 'var(--color-tag-pink-text)' : 'var(--color-tag-green-text)';

  return (
    <div className="flex flex-col" style={{ gap: compact ? 0 : 6, minWidth: compact ? 140 : 240 }}>
      <div style={{ position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: dotSize / 2,
            left: `${edgePct}%`,
            right: `${edgePct}%`,
            height: 2,
            background: 'var(--color-border)',
            borderRadius: 999,
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: dotSize / 2,
            left: `${edgePct}%`,
            width: `${Math.max(0, progressPct)}%`,
            height: 2,
            background: progressColor,
            borderRadius: 999,
          }}
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${stepCount}, minmax(0, 1fr))`,
            alignItems: 'center',
          }}
        >
          {steps.map((step, index) => {
            const isDone = index < resolvedIndex;
            const isCurrent = index === resolvedIndex;
            const isFailedStep = step.key === 'failed';
            const dotBorder = isFailedStep
              ? 'var(--color-tag-pink-text)'
              : isCurrent
              ? 'var(--color-brand)'
              : isDone
              ? 'var(--color-tag-green-text)'
              : 'var(--color-border)';
            const dotBg = isFailedStep
              ? 'var(--color-tag-pink-bg)'
              : isCurrent
              ? 'var(--color-brand)'
              : isDone
              ? 'var(--color-accent-green-bg)'
              : 'transparent';

            return (
              <div key={step.key} className="flex items-center justify-center" style={{ position: 'relative' }}>
                {showPulse && isCurrent && (
                  <span
                    className="status-pulse"
                    style={{
                      width: pulseSize,
                      height: pulseSize,
                      border: `2px solid ${isFailedStep ? 'var(--color-tag-pink-text)' : 'var(--color-brand)'}`,
                    }}
                  />
                )}
                <span
                  style={{
                    width: dotSize,
                    height: dotSize,
                    borderRadius: 999,
                    border: `2px solid ${dotBorder}`,
                    background: dotBg,
                    display: 'inline-block',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {!compact && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${stepCount}, minmax(0, 1fr))`,
            fontSize: labelSize,
            textAlign: 'center',
          }}
        >
          {steps.map((step, index) => {
            const isDone = index < resolvedIndex;
            const isCurrent = index === resolvedIndex;
            const isFailedStep = step.key === 'failed';
            const color = isFailedStep
              ? 'var(--color-tag-pink-text)'
              : isCurrent
              ? 'var(--color-text-primary)'
              : isDone
              ? 'var(--color-tag-green-text)'
              : 'var(--color-text-muted)';
            return (
              <span key={`${step.key}-label`} style={{ color }}>
                {step.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
