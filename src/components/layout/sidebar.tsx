'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/devices', label: 'Geräte' },
  { href: '/profiles', label: 'Profile' },
  { href: '/settings', label: 'Einstellungen' },
  { href: '/history', label: 'Verlauf' },
];

function useActiveLearnCount() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch('/api/charging/learn/status', { signal: ctrl.signal });
        if (cancelled) return;
        if (res.ok) {
          const sessions = await res.json();
          setCount(Array.isArray(sessions) ? sessions.filter((s: { state: string }) => s.state === 'learning').length : 0);
        }
      } catch {
        // ignore (includes AbortError on unmount)
      }
    }

    check();
    const interval = setInterval(check, 15000);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(interval);
    };
  }, []);

  return count;
}

export function Sidebar() {
  const pathname = usePathname();
  const activeLearnCount = useActiveLearnCount();

  function isActive(href: string) {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  return (
    <nav className="w-64 h-screen bg-neutral-900 border-r border-neutral-800 flex flex-col p-4 shrink-0">
      <div className="text-lg font-bold text-neutral-100 mb-8">
        Charging Master
      </div>

      <div className="flex flex-col gap-1 flex-1">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                active
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/50'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </div>

      {/* Active learning sessions indicator */}
      {activeLearnCount > 0 && (
        <Link
          href="/profiles/learn"
          className="flex items-center gap-2 px-3 py-2 mb-2 rounded-md bg-green-500/10 border border-green-500/20 text-xs text-green-300 hover:bg-green-500/20 transition-colors"
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          {activeLearnCount} Lernvorgang{activeLearnCount !== 1 ? 'e' : ''} aktiv
        </Link>
      )}
    </nav>
  );
}
