/**
 * v1.7 — iOS Shortcut / external SoC reporter.
 *
 * `POST /api/devices/<plugId>/report-soc`
 * Body: `{ "soc": <integer 0-100> }`
 *
 * Designed for iOS Shortcuts and similar automations: the phone-side
 * Shortcut detects a "charging state changes" event, reads the device's
 * current battery level, and POSTs it to the active session on the
 * matching plug. Behind the scenes this calls
 * `ChargeMonitor.overrideSession({ estimatedSoc })` — identical effect to
 * the existing PUT /api/charging/sessions/<id> path, but keyed by stable
 * plug ID instead of an ephemeral session ID so the Shortcut never has
 * to look up the current session.
 *
 * Behaviour:
 *   - 404 when no plug with this ID exists.
 *   - 409 when no active session is currently running on this plug
 *     (states detecting / matched / charging / countdown).
 *   - 400 for invalid body (missing/non-numeric/out-of-range SoC).
 *   - 200 with `{ ok, sessionId, before, after, profileName }` on success.
 *
 * Auth: LAN-only via `isAllowedBrowserHost`. iOS Shortcuts running on the
 * phone hit the URL over the same WiFi network the charging-master LXC
 * lives on; the off-LAN case (cellular) simply fails to resolve and is
 * not addressed by this endpoint.
 */

import { db } from '@/db/client';
import { chargeSessions, plugs, deviceProfiles } from '@/db/schema';
import { isAllowedBrowserHost } from '@/lib/host-guard';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

const ACTIVE_STATES = new Set(['detecting', 'matched', 'charging', 'countdown']);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAllowedBrowserHost(request)) {
    return Response.json({ error: 'forbidden_host' }, { status: 403 });
  }

  const { id: plugId } = await context.params;

  let body: { soc?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  const soc = body.soc;
  if (
    typeof soc !== 'number' ||
    !Number.isInteger(soc) ||
    soc < 0 ||
    soc > 100
  ) {
    return Response.json(
      { error: 'invalid_soc', expected: 'integer 0-100' },
      { status: 400 },
    );
  }

  const plug = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
  if (!plug) {
    return Response.json({ error: 'plug_not_found' }, { status: 404 });
  }

  // Find the most-recent active session on this plug. The plug's session
  // history may include older terminated rows; we want the live one.
  const activeSession = db
    .select()
    .from(chargeSessions)
    .where(eq(chargeSessions.plugId, plugId))
    .orderBy(chargeSessions.startedAt)
    .all()
    .reverse()
    .find((s) => ACTIVE_STATES.has(s.state));
  if (!activeSession) {
    return Response.json(
      { error: 'no_active_session', plugId },
      { status: 409 },
    );
  }

  const before = activeSession.estimatedSoc;
  const profileName = activeSession.profileId
    ? db
        .select({ name: deviceProfiles.name })
        .from(deviceProfiles)
        .where(eq(deviceProfiles.id, activeSession.profileId))
        .get()?.name ?? null
    : null;

  if (globalThis.__chargeMonitor) {
    globalThis.__chargeMonitor.overrideSession(activeSession.id, {
      estimatedSoc: soc,
    });
  }

  return Response.json({
    ok: true,
    sessionId: activeSession.id,
    plugId,
    profileName,
    before,
    after: soc,
  });
}
