import { db } from '@/db/client';
import { config } from '@/db/schema';
import { SettingsSection } from '@/components/settings/settings-section';
import { MqttSettings } from '@/components/settings/mqtt-settings';
import { PushoverSettings } from '@/components/settings/pushover-settings';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const rows = db.select().from(config).all();
  const settings: Record<string, string> = Object.fromEntries(
    rows.map((r) => [r.key, r.value]),
  );

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
      <h1 className="text-2xl font-bold text-neutral-100">Einstellungen</h1>

      <SettingsSection
        title="MQTT Broker"
        description="Verbindungseinstellungen für den MQTT-Broker"
      >
        <MqttSettings initialSettings={settings} />
      </SettingsSection>

      <SettingsSection
        title="Pushover"
        description="Benachrichtigungen via Pushover"
      >
        <PushoverSettings initialSettings={settings} />
      </SettingsSection>
    </div>
  );
}
