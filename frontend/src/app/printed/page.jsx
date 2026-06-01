import { JobsView } from '@/components/JobsView';

export default function PrintedPage() {
  return (
    <JobsView
      status="printed"
      title="Printed"
      subtitle="Completed jobs."
      showAdd={false}
      showHeader={false}
    />
  );
}
