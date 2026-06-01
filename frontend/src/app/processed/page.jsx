import { JobsView } from '@/components/JobsView';

export default function ProcessedPage() {
  return (
    <JobsView
      status="processed"
      title="Processed"
      subtitle="PDFs ready to print. Use Create batch to merge several into one."
      showAdd={false}
      showHeader={false}
    />
  );
}
