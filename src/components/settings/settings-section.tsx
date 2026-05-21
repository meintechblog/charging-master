type SettingsSectionProps = {
  title: string;
  description?: string;
  children: React.ReactNode;
};

export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section
      className="p-6"
      style={{
        background: 'var(--color-ink-2)',
        border: '1px solid var(--color-line-soft)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      <div className="flex items-baseline gap-3 mb-1">
        <h2 className="text-[16px] font-semibold tracking-tight text-[color:var(--color-text-strong)]">
          {title}
        </h2>
        <span className="flex-1 h-px" style={{ background: 'var(--color-line-faint)' }} />
      </div>
      {description && (
        <p className="text-[12.5px] text-[color:var(--color-text-faint)] leading-relaxed mt-1.5">
          {description}
        </p>
      )}
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}
