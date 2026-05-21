'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from './sidebar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Close drawer when route changes (mobile UX: tapping a nav link closes it)
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Esc closes the drawer
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDrawerOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // Lock body scroll while drawer is open on mobile
  useEffect(() => {
    if (drawerOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [drawerOpen]);

  return (
    <div className="flex min-h-screen md:h-screen md:overflow-hidden">
      {/* Mobile top bar — translucent, hairline border, mono brand mark. */}
      <header
        className="md:hidden fixed top-0 inset-x-0 z-30 h-12 flex items-center justify-between px-3 backdrop-blur-xl"
        style={{
          background: 'color-mix(in srgb, var(--color-ink-1) 85%, transparent)',
          borderBottom: '1px solid var(--color-line-soft)',
        }}
      >
        <button
          type="button"
          aria-label="Menü öffnen"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((v) => !v)}
          className="p-2 -ml-2 rounded text-[color:var(--color-text-soft)] hover:text-[color:var(--color-text-strong)] hover:bg-[color:var(--color-ink-3)] active:bg-[color:var(--color-ink-4)] transition-colors"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-[color:var(--color-accent)]">
            CM
          </span>
          <span className="text-sm font-medium text-[color:var(--color-text-strong)]">
            Charging Master
          </span>
        </div>
        <div className="w-9" aria-hidden />
      </header>

      {/* Backdrop (mobile only, when drawer open) */}
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — fixed off-canvas drawer on mobile, static rail on md+ */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-50 transform transition-transform duration-200 ease-out md:translate-x-0 ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        } shrink-0`}
      >
        <Sidebar />
      </aside>

      <main
        className="flex-1 overflow-y-auto p-4 md:p-8 pt-16 md:pt-8"
        style={{ background: 'transparent' }}
      >
        <div className="mx-auto max-w-7xl">
          {children}
        </div>
      </main>
    </div>
  );
}
