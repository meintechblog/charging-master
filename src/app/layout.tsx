import type { Metadata } from 'next';
import './globals.css';

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
    <html lang="de" className="dark">
      <body className="bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
