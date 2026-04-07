import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-4">
      <h2 className="text-xl font-bold text-neutral-100">Seite nicht gefunden</h2>
      <Link href="/" className="text-blue-400 hover:text-blue-300 text-sm">
        Zum Dashboard
      </Link>
    </div>
  );
}
