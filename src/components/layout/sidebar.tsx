'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { UpdateInfoView } from '@/modules/self-update/types';

/**
 * Sidebar — "instrument rail" treatment.
 *
 * Brand mark sits at the top: a mono call-sign + name, both with the cyan
 * accent reduced to a hairline underline that re-establishes the brand
 * without shouting. Section divider hairlines separate primary nav from
 * "live status" indicators (active learning sessions). Active-state on
 * a nav row is a 2 px cyan rail on the LEFT — a borrowed pattern from
 * pro DAW / Linear sidebars that's far more legible than a fill.
 */

type NavItem = { href: string; label: string; abbr: string };

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', abbr: '01' },
  { href: '/devices', label: 'Geräte', abbr: '02' },
  { href: '/profiles', label: 'Profile', abbr: '03' },
  { href: '/chargers', label: 'Ladegeräte', abbr: '04' },
  { href: '/catalog', label: 'Katalog', abbr: '05' },
  { href: '/history', label: 'Verlauf', abbr: '06' },
  { href: '/settings', label: 'Einstellungen', abbr: '07' },
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
        /* ignore (includes AbortError on unmount) */
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

function useUpdateAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch('/api/update/status', {
          signal: ctrl.signal,
          cache: 'no-store',
        });
        if (cancelled) return;
        if (res.ok) {
          const info = (await res.json()) as UpdateInfoView;
          setAvailable(Boolean(info.updateAvailable));
        }
      } catch {
        /* ignore */
      }
    }

    check();
    const interval = setInterval(check, 60000);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(interval);
    };
  }, []);

  return available;
}

export function Sidebar() {
  const pathname = usePathname();
  const activeLearnCount = useActiveLearnCount();
  const updateAvailable = useUpdateAvailable();

  function isActive(href: string) {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  return (
    <nav
      className="w-64 h-screen flex flex-col shrink-0"
      style={{
        background: 'var(--color-ink-1)',
        borderRight: '1px solid var(--color-line-soft)',
      }}
    >
      {/* Brand mark — mono call-sign with a thin cyan underbar. */}
      <Link
        href="/"
        className="block px-5 pt-6 pb-5 group"
      >
        <div className="flex items-baseline gap-2.5">
          <span
            className="font-mono text-[11px] tracking-[0.22em] uppercase"
            style={{ color: 'var(--color-accent)' }}
          >
            CM
          </span>
          <span className="text-[15px] font-medium tracking-tight text-[color:var(--color-text-strong)]">
            Charging Master
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <span
            className="block h-px w-6 transition-all duration-200 group-hover:w-10"
            style={{ background: 'var(--color-accent)' }}
          />
          <span className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-text-muted)]">
            v1.8
          </span>
        </div>
      </Link>

      <div className="hairline mx-5" />

      {/* Primary navigation. The active item gets a 2 px cyan rail on the
          left edge of the row + a slightly elevated surface, instead of a
          full background fill — far more legible at a glance. */}
      <ul className="flex flex-col gap-px py-3 px-3">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href);
          const showUpdateDot = item.href === '/settings' && updateAvailable;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className="relative flex items-center gap-3 pl-4 pr-3 py-[7px] rounded-[6px] text-[13px] font-medium transition-colors group"
                style={{
                  color: active
                    ? 'var(--color-text-strong)'
                    : 'var(--color-text-soft)',
                  background: active ? 'var(--color-ink-3)' : 'transparent',
                }}
              >
                {/* Cyan rail — only visible on active. Fades on hover for
                    inactive rows so the user gets a hint of where the row
                    would land. */}
                <span
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-r-full transition-all duration-150"
                  style={{
                    background: active
                      ? 'var(--color-accent)'
                      : 'transparent',
                    boxShadow: active
                      ? '0 0 8px 0 var(--color-accent-glow)'
                      : 'none',
                  }}
                />

                {/* Mono index — "01 Dashboard" — makes the rail feel
                    deliberately serialised, like an instrument panel. */}
                <span
                  className="font-mono text-[10px] tabular-nums"
                  style={{
                    color: active
                      ? 'var(--color-accent)'
                      : 'var(--color-text-muted)',
                  }}
                >
                  {item.abbr}
                </span>
                <span className="flex-1">{item.label}</span>
                {showUpdateDot && (
                  <span
                    aria-label="Update verfügbar"
                    title="Update verfügbar"
                    className="status-orb"
                    style={{ color: 'var(--color-warn)' }}
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="flex-1" />

      {/* Live-status footer — active learn sessions get their own pulsing
          channel here so the user always knows a learn is running, no
          matter what page they're on. */}
      {activeLearnCount > 0 && (
        <>
          <div className="hairline mx-5" />
          <Link
            href="/profiles/learn"
            className="mx-3 my-3 flex items-center gap-3 px-3 py-2.5 rounded-md lift-hover group"
            style={{
              background: 'var(--color-ok-soft)',
              border: '1px solid color-mix(in srgb, var(--color-ok) 30%, transparent)',
            }}
          >
            <span className="status-orb status-orb-pulse" style={{ color: 'var(--color-ok)' }} />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-[0.16em] font-medium" style={{ color: 'var(--color-ok)' }}>
                Live
              </div>
              <div className="text-[12px] text-[color:var(--color-text-default)] truncate">
                {activeLearnCount} Lernvorgang{activeLearnCount !== 1 ? 'e' : ''} aktiv
              </div>
            </div>
          </Link>
        </>
      )}

      {/* Bottom-of-rail metadata — distinct from nav, looks "stamped". */}
      <div
        className="px-5 py-4 flex items-center justify-between"
        style={{ borderTop: '1px solid var(--color-line-faint)' }}
      >
        <span className="label-eyebrow">LAN · single-user</span>
        <span className="status-orb" style={{ color: 'var(--color-ok)' }} />
      </div>
    </nav>
  );
}
