'use client';

const SOC_STEPS = [50, 60, 70, 80, 90, 100];

type SocButtonsProps = {
  value: number;
  onChange: (soc: number) => void;
  disabled?: boolean;
};

export function SocButtons({ value, onChange, disabled }: SocButtonsProps) {
  return (
    <div className="flex gap-1 flex-wrap">
      {SOC_STEPS.map((soc) => (
        <button
          key={soc}
          onClick={() => onChange(soc)}
          disabled={disabled}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            value === soc
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {soc}%
        </button>
      ))}
    </div>
  );
}
