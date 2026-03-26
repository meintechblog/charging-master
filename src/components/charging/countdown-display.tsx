'use client';

type CountdownDisplayProps = {
  estimatedSoc: number;
  targetSoc: number;
};

export function CountdownDisplay({ estimatedSoc, targetSoc }: CountdownDisplayProps) {
  const remaining = targetSoc - estimatedSoc;
  const windowStart = targetSoc - 5;
  const progress = Math.max(0, Math.min(1, (estimatedSoc - windowStart) / 5));

  // SVG circle parameters
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  // Color transition from blue-500 to green-500
  const r = Math.round(59 + (34 - 59) * progress);
  const g = Math.round(130 + (197 - 130) * progress);
  const b = Math.round(246 + (94 - 246) * progress);
  const strokeColor = `rgb(${r},${g},${b})`;

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width="100" height="100" viewBox="0 0 100 100" className="animate-pulse-slow">
        {/* Background ring */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="#262626"
          strokeWidth="6"
        />
        {/* Progress ring */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          transform="rotate(-90 50 50)"
          className="transition-all duration-1000 ease-linear"
        />
        {/* Center text */}
        <text
          x="50"
          y="46"
          textAnchor="middle"
          className="text-2xl font-bold"
          fill="white"
        >
          {remaining}%
        </text>
        <text
          x="50"
          y="62"
          textAnchor="middle"
          className="text-[10px]"
          fill="#a3a3a3"
        >
          verbleibend
        </text>
      </svg>
    </div>
  );
}
