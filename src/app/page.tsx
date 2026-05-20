import { db } from '@/db/client';
import {
  plugs,
  powerReadings,
  chargeSessions,
  deviceProfiles,
  profilePhotos,
} from '@/db/schema';
import { desc, eq, isNotNull, inArray, and } from 'drizzle-orm';
import { DashboardChargeBanners } from '@/components/charging/dashboard-charge-banners';
import { FlaggedSessionsBanner } from '@/components/charging/flagged-sessions-banner';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const ACTIVE_STATES = ['detecting', 'matched', 'charging', 'countdown'] as const;

export default async function HomePage() {
  const allPlugs = db.select().from(plugs).all();

  // Pre-fetch active sessions server-side so the dashboard renders the
  // prominent "active charge" cards on first paint — without this, the
  // client SSE stream takes 1–2 s to confirm which plugs are active and the
  // user sees a flash of "everyone is idle" before the layout reflows.
  const activeRows = db
    .select({
      sessionId: chargeSessions.id,
      plugId: chargeSessions.plugId,
      profileId: chargeSessions.profileId,
      profileName: deviceProfiles.name,
      state: chargeSessions.state,
      estimatedSoc: chargeSessions.estimatedSoc,
      socMin: chargeSessions.socMin,
      socMax: chargeSessions.socMax,
      targetSoc: chargeSessions.targetSoc,
      energyWh: chargeSessions.energyWh,
      bandConfidence: chargeSessions.bandConfidence,
      startedAt: chargeSessions.startedAt,
    })
    .from(chargeSessions)
    .leftJoin(deviceProfiles, eq(chargeSessions.profileId, deviceProfiles.id))
    .where(inArray(chargeSessions.state, [...ACTIVE_STATES]))
    .all();

  // For each active session's profile, pick the primary photo (if any) so
  // the card can render a thumbnail without an extra client fetch.
  const activeProfileIds = activeRows
    .map((r) => r.profileId)
    .filter((id): id is number => id != null);
  const photoRows = activeProfileIds.length > 0
    ? db
        .select({
          profileId: profilePhotos.profileId,
          id: profilePhotos.id,
          isPrimary: profilePhotos.isPrimary,
        })
        .from(profilePhotos)
        .where(
          and(
            inArray(profilePhotos.profileId, activeProfileIds),
            // No isPrimary filter — we want all photos so we can pick the
            // primary if one is flagged, otherwise the first.
          )
        )
        .all()
    : [];
  const photoByProfile = new Map<number, number>();
  for (const p of photoRows) {
    if (p.isPrimary) photoByProfile.set(p.profileId, p.id);
    else if (!photoByProfile.has(p.profileId)) photoByProfile.set(p.profileId, p.id);
  }

  const activeByPlug = new Map<
    string,
    {
      sessionId: number;
      profileId: number | null;
      profileName: string | null;
      photoUrl: string | null;
      state: string;
      estimatedSoc: number | null;
      socMin: number | null;
      socMax: number | null;
      targetSoc: number;
      energyWh: number;
      bandConfidence: number | null;
      startedAt: number;
    }
  >();
  for (const r of activeRows) {
    const photoId = r.profileId != null ? photoByProfile.get(r.profileId) : undefined;
    activeByPlug.set(r.plugId, {
      sessionId: r.sessionId,
      profileId: r.profileId ?? null,
      profileName: r.profileName ?? null,
      photoUrl:
        r.profileId != null && photoId != null
          ? `/api/profiles/${r.profileId}/photos/${photoId}/file`
          : null,
      state: r.state,
      estimatedSoc: r.estimatedSoc ?? null,
      socMin: r.socMin ?? null,
      socMax: r.socMax ?? null,
      targetSoc: r.targetSoc ?? 80,
      energyWh: r.energyWh ?? 0,
      bandConfidence: r.bandConfidence ?? null,
      startedAt: r.startedAt,
    });
  }

  // Get latest power reading per plug for initial relay state
  const plugsWithOutput = allPlugs.map((plug) => {
    const latest = db
      .select({ output: powerReadings.output })
      .from(powerReadings)
      .where(eq(powerReadings.plugId, plug.id))
      .orderBy(desc(powerReadings.timestamp))
      .limit(1)
      .get();

    return {
      ...plug,
      output: latest?.output ?? false,
    };
  });

  // v1.7-C post-cycle calibration banner. Count sessions flagged by the
  // self-calibration scorer (delivered Wh didn't fit committed profile,
  // or another profile fits better). Server-rendered count is fine — the
  // banner is informational, not real-time.
  const flaggedCount = db
    .select({ id: chargeSessions.id })
    .from(chargeSessions)
    .where(isNotNull(chargeSessions.flagReason))
    .all().length;

  return (
    <div>
      <h1 className="text-2xl font-bold text-neutral-100 mb-6">Dashboard</h1>

      {flaggedCount > 0 && <FlaggedSessionsBanner count={flaggedCount} />}

      {plugsWithOutput.length === 0 ? (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-8 text-center">
          <p className="text-neutral-400 mb-4">Keine Geräte hinzugefügt</p>
          <Link
            href="/devices"
            className="text-blue-400 hover:text-blue-300 underline text-sm"
          >
            Gerät hinzufügen
          </Link>
        </div>
      ) : (
        <DashboardChargeBanners
          plugs={plugsWithOutput.map((p) => ({
            id: p.id,
            name: p.name,
            ipAddress: p.ipAddress,
            online: p.online,
            enabled: p.enabled,
            lastSeen: p.lastSeen,
            output: p.output,
          }))}
          initialActiveByPlug={Object.fromEntries(activeByPlug)}
        />
      )}
    </div>
  );
}
