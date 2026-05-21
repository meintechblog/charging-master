import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { AppShell } from '@/components/layout/app-shell';
import { NavProgress } from '@/components/layout/nav-progress';
import './globals.css';

// IBM Plex Sans — chosen over Inter/Roboto/Space-Grotesk: it was designed
// for IBM's industrial brand, has distinctive open apertures and a stable
// rhythm that holds up at small sizes. Pairs natively with Plex Mono so the
// numeric column inherits the same family DNA.
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-plex-sans',
  display: 'swap',
});

// IBM Plex Mono — every number in the UI (SoC %, watts, energy, time) is
// data, not prose. Tabular figures eliminate the digit-jitter that makes
// dashboards feel cheap.
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Charging Master',
  description: 'Smart Charging Management',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="de" className={`dark ${plexSans.variable} ${plexMono.variable}`}>
      <body className="antialiased">
        <NavProgress />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
