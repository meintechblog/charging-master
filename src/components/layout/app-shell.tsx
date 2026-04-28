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
      {/* Mobile top bar (hidden on md+) */}
      <header className="md:hidden fixed top-0 inset-x-0 z-30 h-12 bg-neutral-900/95 backdrop-blur border-b border-neutral-800 flex items-center justify-between px-3">
        <button
          type="button"
          aria-label="Menü öffnen"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((v) => !v)}
          className="p-2 -ml-2 rounded text-neutral-300 hover:bg-neutral-800 active:bg-neutral-700 transition-colors"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <div className="text-sm font-semibold text-neutral-100">Charging Master</div>
        <div className="w-9" aria-hidden />
      </header>

      {/* Backdrop (mobile only, when drawer open) */}
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
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

      <main className="flex-1 overflow-y-auto bg-neutral-950 p-4 md:p-6 pt-16 md:pt-6">
        {children}
      </main>
    </div>
  );
}
