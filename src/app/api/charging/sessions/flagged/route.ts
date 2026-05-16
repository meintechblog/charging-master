/**
 * GET /api/charging/sessions/flagged — list sessions surfaced by the
 * v1.7-C post-cycle calibration. A "flagged" session is one whose
 * delivered Wh didn't fit the committed profile within VERIFY_TOLERANCE
 * (default 20 %), OR where another candidate fits noticeably better.
 *
 * Used by the dashboard banner that nudges the user to re-classify or
 * update their device profile catalogue.
 */

import { db } from '@/db/client';
import { chargeSessions, plugs, deviceProfiles } from '@/db/schema';
import { eq, isNotNull } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET() {
  const rows = db
    .select({
      id: chargeSessions.id,
      plugId: chargeSessions.plugId,
      profileId: chargeSessions.profileId,
      stoppedAt: chargeSessions.stoppedAt,
      energyWh: chargeSessions.energyWh,
      flagReason: chargeSessions.flagReason,
      plugName: plugs.name,
      profileName: deviceProfiles.name,
    })
    .from(chargeSessions)
    .leftJoin(plugs, eq(chargeSessions.plugId, plugs.id))
    .leftJoin(deviceProfiles, eq(chargeSessions.profileId, deviceProfiles.id))
    .where(isNotNull(chargeSessions.flagReason))
    .all();

  return Response.json({
    flagged: rows.map((r) => ({
      sessionId: r.id,
      plugId: r.plugId,
      plugName: r.plugName,
      profileId: r.profileId,
      profileName: r.profileName,
      stoppedAt: r.stoppedAt,
      energyWh: r.energyWh,
      flagReason: r.flagReason,
    })),
    count: rows.length,
  });
}
