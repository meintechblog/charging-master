import { db } from '@/db/client';
import { config } from '@/db/schema';
import { SettingsSection } from '@/components/settings/settings-section';
import { PushoverSettings } from '@/components/settings/pushover-settings';
import { ElectricitySettings } from '@/components/settings/electricity-settings';
import { ChargingSettings } from '@/components/settings/charging-settings';
import { AutoUpdateSettings } from '@/components/settings/auto-update-settings';
import { CatalogSettings } from '@/components/settings/catalog-settings';
import { VersionBadge } from './version-badge';
import { UpdateBanner } from './update-banner';
import { UpdateHistory } from './update-history';
import { UpdateStateStore } from '@/modules/self-update/update-state-store';
import type { UpdateInfoView } from '@/modules/self-update/types';
import { CURRENT_SHA, CURRENT_SHA_SHORT } from '@/lib/version';
import { PageHeader } from '@/components/layout/page-header';

export const dynamic = 'force-dynamic';

/**
 * Read the initial UpdateInfoView server-side so the banner renders with real
 * data on first paint (no loading flash). Degrades to a 'never' view if the
 * state store is somehow unreadable — matches the fallback in GET /api/update/status.
 */
function getInitialUpdateInfo(): UpdateInfoView {
  try {
    return new UpdateStateStore().getUpdateInfo();
  } catch {
    return {
      currentSha: CURRENT_SHA,
      currentShaShort: CURRENT_SHA_SHORT,
      lastCheckAt: null,
      lastCheckStatus: 'never',
      updateAvailable: false,
    };
  }
}

export default async function SettingsPage() {
  const rows = db.select().from(config).all();
  const settings: Record<string, string> = Object.fromEntries(
    rows.map((r) => [r.key, r.value]),
  );

  const initialUpdateInfo = getInitialUpdateInfo();

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <PageHeader
        eyebrow="Konfiguration · 07"
        title="Einstellungen"
        action={<VersionBadge />}
      />

      <UpdateBanner initialInfo={initialUpdateInfo} />

      <UpdateHistory />

      <SettingsSection
        title="Pushover"
        description="Benachrichtigungen via Pushover"
      >
        <PushoverSettings initialSettings={settings} />
      </SettingsSection>

      <SettingsSection
        title="Strompreis"
        description="Wird für Kosten-Anzeige in Notifications und Session-Details verwendet"
      >
        <ElectricitySettings initialSettings={settings} />
      </SettingsSection>

      <SettingsSection
        title="Laden"
        description="Stopp-Verhalten und Band-Konfiguration"
      >
        <ChargingSettings initialSettings={settings} />
      </SettingsSection>

      <SettingsSection
        title="Auto-Update"
        description="App aktualisiert sich automatisch in der gewählten Stunde, wenn keine aktive Lade-Session läuft"
      >
        <AutoUpdateSettings initialSettings={settings} />
      </SettingsSection>

      <SettingsSection
        title="Profil-Katalog"
        description="Geteilter Wissens-Pool für Akku- und Ladegeräte-Profile mit allen anderen Charging-Master-Instanzen"
      >
        <CatalogSettings initialSettings={settings} />
      </SettingsSection>
    </div>
  );
}
