/**
 * v1.7-A++ : GET /api/devices/<plugId>/shortcut.plist
 *
 * Serves the iOS Shortcut XML property-list document for this plug.
 * Apple's Shortcuts.app accepts this as an "Untrusted Shortcut" import
 * (the user must enable that toggle in iOS Settings → Shortcuts; see
 * docs/ios-shortcut-setup.md).
 *
 * The companion /shortcut-install route handles the iOS-vs-other UA sniff
 * and the `shortcuts://import-shortcut` redirect.
 */

import { db } from '@/db/client';
import { plugs } from '@/db/schema';
import { isAllowedBrowserHost } from '@/lib/host-guard';
import {
  buildReportSocShortcutPlist,
  plugFilenameSlug,
} from '@/modules/ios-shortcut/build-shortcut-plist';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAllowedBrowserHost(request)) {
    return Response.json({ error: 'forbidden_host' }, { status: 403 });
  }

  const { id: plugId } = await context.params;

  const plug = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
  if (!plug) {
    return Response.json({ error: 'plug_not_found' }, { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;

  const plistBody = buildReportSocShortcutPlist({
    plugId: plug.id,
    plugName: plug.name,
    baseUrl,
  });

  const slug = plugFilenameSlug(plug.name);

  return new Response(plistBody, {
    status: 200,
    headers: {
      // Apple's UTI for unsigned shortcuts. Safari + Shortcuts.app key
      // their handling off this MIME.
      'Content-Type': 'application/x-apple-shortcut',
      'Content-Disposition': `attachment; filename="Charging-Master-SoC-${slug}.shortcut"`,
      // Don't cache — the LAN base URL can change (Tailscale, mDNS) and
      // the plug name might be renamed.
      'Cache-Control': 'no-store',
    },
  });
}
