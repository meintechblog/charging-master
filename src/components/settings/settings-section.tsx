type SettingsSectionProps = {
  title: string;
  description?: string;
  children: React.ReactNode;
};

export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
      <h2 className="text-lg font-semibold text-neutral-100">{title}</h2>
      {description && (
        <p className="text-sm text-neutral-400 mt-1">{description}</p>
      )}
      <div className="mt-4 space-y-4">
        {children}
      </div>
    </section>
  );
}
