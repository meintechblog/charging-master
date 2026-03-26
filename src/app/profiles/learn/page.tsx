'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { LearnWizard } from '@/components/charging/learn-wizard';

function LearnContent() {
  const searchParams = useSearchParams();
  const profileId = searchParams.get('profileId') ?? undefined;
  const plugId = searchParams.get('plugId') ?? undefined;

  return (
    <div>
      <h1 className="text-2xl font-bold text-neutral-100 mb-6">Geraet anlernen</h1>
      <LearnWizard initialProfileId={profileId} initialPlugId={plugId} />
    </div>
  );
}

export default function LearnPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <span className="text-neutral-400 text-sm">Laden...</span>
        </div>
      }
    >
      <LearnContent />
    </Suspense>
  );
}
