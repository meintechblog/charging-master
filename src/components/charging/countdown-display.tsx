'use client';

type CountdownDisplayProps = {
  estimatedSoc: number;
  targetSoc: number;
};

export function CountdownDisplay({ estimatedSoc, targetSoc }: CountdownDisplayProps) {
  const remaining = Math.max(0, targetSoc - estimatedSoc);
  const windowStart = targetSoc - 5;
  const progress = Math.max(0, Math.min(1, (estimatedSoc - windowStart) / 5));

  // Color transition from blue-500 to green-500 on the progress ring.
  const r = Math.round(59 + (34 - 59) * progress);
  const g = Math.round(130 + (197 - 130) * progress);
  const b = Math.round(246 + (94 - 246) * progress);
  const strokeColor = `rgb(${r},${g},${b})`;

  const size = 160;
  const radius = 68;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <div className="flex items-center gap-5">
      {/* Circular progress with big current SOC inside */}
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="animate-pulse-slow">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#262626"
            strokeWidth="8"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className="transition-all duration-1000 ease-linear"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-5xl font-bold text-neutral-100 tabular-nums leading-none">
            {estimatedSoc}
          </span>
          <span className="text-xs text-neutral-500 mt-1">% aktuell</span>
        </div>
      </div>

      {/* Target + remaining stat */}
      <div className="flex flex-col gap-2 min-w-0">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">
            verbleibend
          </div>
          <div className="text-4xl font-semibold text-neutral-100 tabular-nums leading-none">
            {remaining}
            <span className="text-xl text-neutral-500 ml-1">%</span>
          </div>
        </div>
        <div className="text-xs text-neutral-500">
          Ziel: <span className="text-neutral-300 tabular-nums">{targetSoc} %</span>
        </div>
      </div>
    </div>
  );
}
