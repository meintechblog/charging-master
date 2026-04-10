'use client';

import type { UpdatePipelineStage } from '@/modules/self-update/types';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'rolled_back';

type Props = {
  /** The stage currently running, or null if no stage has been observed yet. */
  currentStage: UpdatePipelineStage | null;
  /** Overall pipeline status. When 'failed' the currentStage is marked red, earlier stages green. */
  status: 'running' | 'done' | 'failed' | 'rolled_back';
};

const STAGES: Array<{ id: UpdatePipelineStage; label: string }> = [
  { id: 'preflight', label: 'Preflight' },
  { id: 'snapshot',  label: 'Snapshot' },
  { id: 'drain',     label: 'Drain' },
  { id: 'stop',      label: 'Stop' },
  { id: 'fetch',     label: 'Fetch' },
  { id: 'install',   label: 'Install' },
  { id: 'build',     label: 'Build' },
  { id: 'start',     label: 'Start' },
  { id: 'verify',    label: 'Verify' },
];

function statusFor(stageIndex: number, currentIndex: number, overall: Props['status']): StepStatus {
  if (currentIndex === -1) return stageIndex === 0 ? 'pending' : 'pending';
  if (stageIndex < currentIndex) return 'done';
  if (stageIndex === currentIndex) {
    if (overall === 'failed') return 'failed';
    if (overall === 'rolled_back') return 'rolled_back';
    if (overall === 'done') return 'done';
    return 'running';
  }
  return 'pending';
}

export function UpdateStageStepper({ currentStage, status }: Props) {
  const currentIndex = currentStage === null ? -1 : STAGES.findIndex(s => s.id === currentStage);

  return (
    <ol
      className="flex flex-wrap items-center gap-x-1 gap-y-3 text-xs"
      aria-label="Update Fortschritt"
    >
      {STAGES.map((stage, i) => {
        const s = statusFor(i, currentIndex, status);
        const dotClass = {
          pending:     'bg-neutral-700 text-neutral-500 border-neutral-700',
          running:     'bg-blue-500 text-white border-blue-400 animate-pulse',
          done:        'bg-green-600 text-white border-green-500',
          failed:      'bg-red-600 text-white border-red-500',
          rolled_back: 'bg-amber-500 text-neutral-900 border-amber-400',
        }[s];
        const labelClass = {
          pending:     'text-neutral-500',
          running:     'text-blue-300 font-semibold',
          done:        'text-green-300',
          failed:      'text-red-300 font-semibold',
          rolled_back: 'text-amber-300 font-semibold',
        }[s];
        const icon = s === 'done' ? '✓' : s === 'failed' ? '✕' : s === 'rolled_back' ? '↺' : String(i + 1);
        return (
          <li key={stage.id} className="flex items-center gap-2">
            <span
              className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-mono ${dotClass}`}
              aria-label={`Stufe ${i + 1}: ${stage.label}, Status ${s}`}
            >
              {icon}
            </span>
            <span className={labelClass}>{stage.label}</span>
            {i < STAGES.length - 1 && <span className="mx-1 text-neutral-700">→</span>}
          </li>
        );
      })}
    </ol>
  );
}
