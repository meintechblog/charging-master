import { db } from '@/db/client';
import { config } from '@/db/schema';
import { SettingsSection } from '@/components/settings/settings-section';
import { PushoverSettings } from '@/components/settings/pushover-settings';
import { ElectricitySettings } from '@/components/settings/electricity-settings';
import { AutoUpdateSettings } from '@/components/settings/auto-update-settings';
import { VersionBadge } from './version-badge';
import { UpdateBanner } from './update-banner';
import { UpdateHistory } from './update-history';
import { UpdateStateStore } from '@/modules/self-update/update-state-store';
import type { UpdateInfoView } from '@/modules/self-update/types';
import { CURRENT_SHA, CURRENT_SHA_SHORT } from '@/lib/version';

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
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-100">Einstellungen</h1>
        <VersionBadge />
      </div>

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
        title="Auto-Update"
        description="App aktualisiert sich automatisch in der gewählten Stunde, wenn keine aktive Lade-Session läuft"
      >
        <AutoUpdateSettings initialSettings={settings} />
      </SettingsSection>
    </div>
  );
}
