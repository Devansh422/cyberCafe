'use client';
import useSWR from 'swr';
import { api } from '@/lib/api';
import { SectionHeader } from '@/components/SectionHeader';
import { TaskCard } from '@/components/TaskCard';

export default function QueuePage() {
  const { data, mutate } = useSWR('/system/status', api.fetcher, { refreshInterval: 2000 });
  const { data: jobs } = useSWR('/jobs', api.fetcher, { refreshInterval: 2000 });

  const queue = data?.queue || [];
  const printing = (jobs?.jobs || []).filter((j) => j.status === 'printing');
  const queuedJobs = queue
    .map((q) => (jobs?.jobs || []).find((j) => j.id === q.jobId))
    .filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-bold tracking-tight" style={{ fontSize: 28, letterSpacing: '-0.02em' }}>
          Print Queue
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Live state of the local print agent. Jobs flow Pending → Printing → Printed.
        </p>
      </div>

      <section>
        <SectionHeader title="Printing now" count={printing.length} />
        {printing.length === 0 ? (
          <div
            className="text-sm text-text-secondary"
            style={{
              background: 'var(--color-bg-surface)',
              borderRadius: 16,
              padding: 24,
              boxShadow: 'var(--shadow-card)',
            }}
          >
            Nothing printing right now.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {printing.map((j) => (
              <TaskCard key={j.id} job={j} onClick={() => mutate()} variant="list" showQueued />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeader title="Pending" count={queuedJobs.length} />
        {queuedJobs.length === 0 ? (
          <div
            className="text-sm text-text-secondary"
            style={{
              background: 'var(--color-bg-surface)',
              borderRadius: 16,
              padding: 24,
              boxShadow: 'var(--shadow-card)',
            }}
          >
            No jobs queued.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {queuedJobs.map((j) => (
              <TaskCard
                key={j.id}
                job={j}
                onClick={() => mutate()}
                variant="list"
                timelineKey="queued"
                showQueued
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
