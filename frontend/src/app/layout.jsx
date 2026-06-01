import './globals.css';
import { TopNav } from '@/components/TopNav';
import { ActivitySidebar } from '@/components/ActivitySidebar';

export const metadata = {
  title: 'Ratan — Cyber Cafe Print Automation',
  description: 'WhatsApp → Media Center → One-Click Print',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 320px',
            gridTemplateRows: 'auto 1fr',
            minHeight: '100vh',
            background: 'var(--color-bg-app)',
          }}
        >
          <div style={{ gridColumn: '1 / -1' }}>
            <TopNav />
          </div>
          <main
            style={{
              padding: 24,
              overflowY: 'auto',
              height: 'calc(100vh - 56px)',
            }}
          >
            {children}
          </main>
          <ActivitySidebar />
        </div>
      </body>
    </html>
  );
}
