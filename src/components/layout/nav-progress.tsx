'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Top-of-page progress bar that fires on every same-origin link click and
 * resets when the path actually changes. Modeled on NProgress / GitHub's nav
 * bar — gives the user instant visual feedback that the click landed, even
 * before the server-rendered HTML arrives. The 1 MB-of-JS-on-cold-load era
 * is over (W1 bundle diet) but humans still feel anything > 100 ms as
 * "hängt", so the bar bridges that perceptual gap.
 *
 * Implementation notes:
 *  - Capture-phase listener on document for `click`, so it fires before
 *    next/link's own handler — we never get a chance to know "the user
 *    intends to navigate" through router events alone.
 *  - Filters: skip hash anchors, mailto:, new tab, modifier keys, external
 *    domains, identical-path clicks.
 *  - Auto-progresses to 90 % over ~600 ms with eased ramp so it doesn't
 *    sit at the same %. Snaps to 100 % once usePathname() observes the new
 *    path, then fades out.
 *  - Pure CSS animation via Tailwind. No external dependency.
 */
export function NavProgress() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (!target) return;
      const link = target.closest<HTMLAnchorElement>('a[href]');
      if (!link) return;
      if (link.target === '_blank') return;
      if (link.hasAttribute('download')) return;

      const href = link.getAttribute('href');
      if (!href) return;
      if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

      try {
        const url = new URL(href, location.href);
        if (url.origin !== location.origin) return;
        if (url.pathname === location.pathname && url.search === location.search) return;
      } catch {
        return;
      }

      setLoading(true);
      setVisible(true);
      setProgress(8);
    }

    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);

  // Ramp from current to 90 % while still loading.
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => {
      setProgress((p) => (p < 90 ? p + (90 - p) * 0.18 : p));
    }, 80);
    return () => clearInterval(id);
  }, [loading]);

  // pathname changed → completion + fade.
  useEffect(() => {
    if (!loading) return;
    setProgress(100);
    setLoading(false);
    const fade = setTimeout(() => setVisible(false), 260);
    const reset = setTimeout(() => setProgress(0), 520);
    return () => {
      clearTimeout(fade);
      clearTimeout(reset);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (!visible && progress === 0) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[2px] overflow-hidden"
    >
      <div
        className="h-full bg-blue-500 transition-[width,opacity] duration-200 ease-out shadow-[0_0_8px_rgba(59,130,246,0.7)]"
        style={{
          width: `${progress}%`,
          opacity: visible ? 1 : 0,
        }}
      />
    </div>
  );
}
