'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WhatsAppStatus } from './WhatsAppQR';
import { NetworkStatus } from './NetworkStatus';
import { CheckUpdatesButton } from './CheckUpdatesButton';

const NAV = [
  { href: '/', label: 'Incoming' },
  { href: '/processed', label: 'Processed' },
  { href: '/passport', label: 'Passport' },
  { href: '/printed', label: 'Printed' },
  { href: '/failed', label: 'Failed' },
  { href: '/whatsapp', label: 'WhatsApp' },
  { href: '/diagnostics', label: 'Diagnostics' },
];

export function TopNav() {
  const pathname = usePathname();
  return (
    <header
      className="flex items-center justify-between bg-bg-surface shadow-nav"
      style={{ height: 56, padding: '0 24px' }}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center rounded-pill bg-brand text-brand-fg"
          style={{ width: 28, height: 28 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19" />
          </svg>
        </div>
        <span className="text-lg font-extrabold tracking-tight">Ratan</span>
      </div>

      <nav className="flex items-center gap-1">
        {NAV.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`text-base transition-all duration-150 ${
                active
                  ? 'bg-brand text-brand-fg font-semibold'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
              style={{ padding: '6px 16px', borderRadius: 999 }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-3">
        <CheckUpdatesButton />
        <NetworkStatus />
        <WhatsAppStatus />
      </div>
    </header>
  );
}
