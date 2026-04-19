'use client';

type CountdownDisplayProps = {
  estimatedSoc: number;
  targetSoc: number;
};

export function CountdownDisplay({ estimatedSoc, targetSoc }: CountdownDisplayProps) {
  // Progress toward the target — NOT the narrow 5% countdown window. At
  // 77/80 the ring should read as ~96% full, not 40%.
  const progress = targetSoc > 0 ? Math.max(0, Math.min(1, estimatedSoc / targetSoc)) : 0;

  // Ring blends blue → green as SOC approaches target.
  const r = Math.round(59 + (34 - 59) * progress);
  const g = Math.round(130 + (197 - 130) * progress);
  const b = Math.round(246 + (94 - 246) * progress);
  const strokeColor = `rgb(${r},${g},${b})`;

  const size = 192;
  const radius = 84;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <div className="flex justify-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="animate-pulse-slow">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#262626"
            strokeWidth="10"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className="transition-all duration-1000 ease-linear"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-7xl font-bold text-neutral-100 tabular-nums leading-none">
            {estimatedSoc}
            <span className="text-3xl text-neutral-500 ml-1">%</span>
          </span>
          <span className="text-xs text-neutral-500 mt-2 tabular-nums">
            Ziel {targetSoc} %
          </span>
        </div>
      </div>
    </div>
  );
}
