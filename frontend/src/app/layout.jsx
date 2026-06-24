import './globals.css';
import { TopNav } from '@/components/TopNav';
import { ActivitySidebar } from '@/components/ActivitySidebar';
import { UpdateNotifier } from '@/components/UpdateNotifier';
import { UpdateProvider } from '@/components/UpdateContext';
import { ComponentsSetup } from '@/components/ComponentsSetup';

export const metadata = {
  title: 'Ratan — Cyber Cafe Print Automation',
  description: 'WhatsApp → Media Center → One-Click Print',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <UpdateProvider>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 320px',
              gridTemplateRows: 'auto 1fr',
              height: '100vh',
              maxWidth: '100vw',
              overflow: 'hidden',
              background: 'var(--color-bg-app)',
            }}
          >
            <div style={{ gridColumn: '1 / -1' }}>
              <TopNav />
            </div>
            <main
              style={{
                padding: 24,
                minWidth: 0,
                overflowY: 'auto',
                overflowX: 'hidden',
                height: 'calc(100vh - 56px)',
              }}
            >
              {children}
            </main>
            <ActivitySidebar />
          </div>
          <UpdateNotifier />
          <ComponentsSetup />
        </UpdateProvider>
      </body>
    </html>
  );
}
