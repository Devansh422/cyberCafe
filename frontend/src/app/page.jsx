import { JobsView } from '@/components/JobsView';

export default function IncomingPage() {
  return (
    <JobsView
      status="incoming"
      title="Incoming"
      subtitle="Files received from WhatsApp, ready to process and print."
      showHeader={false}
    />
  );
}
