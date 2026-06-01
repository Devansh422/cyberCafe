import { JobsView } from '@/components/JobsView';

export default function FailedPage() {
  return (
    <JobsView
      status="failed"
      title="Failed"
      subtitle="Errors during processing or printing. Retry or delete."
      showAdd={false}
      showHeader={false}
    />
  );
}
