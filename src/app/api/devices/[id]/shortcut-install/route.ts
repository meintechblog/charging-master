/**
 * v1.7-A++ : GET /api/devices/<plugId>/shortcut-install
 *
 * The "install" entry point. On iOS, redirects to
 *   shortcuts://import-shortcut?url=<absolute .plist URL>&name=<encoded>
 * which opens Shortcuts.app's import dialog. On non-iOS clients,
 * redirects to the .plist endpoint directly so the file downloads.
 *
 * Why a wrapper instead of pointing the button at /shortcut.plist?
 * Safari on iOS does NOT automatically hand off `application/x-apple-
 * shortcut` to Shortcuts.app — it tries to render or download. The
 * shortcuts:// URL scheme is the one reliable iOS hand-off.
 */

import { db } from '@/db/client';
import { plugs } from '@/db/schema';
import { isAllowedBrowserHost } from '@/lib/host-guard';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

function isIosUserAgent(ua: string | null): boolean {
  if (!ua) return false;
  // iPadOS 13+ Safari reports a desktop UA by default. We accept either
  // the classic iPhone/iPad/iPod markers OR a Mac-token combined with
  // touch hints (cellular hotspot users on iPad).
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  if (/Macintosh/.test(ua) && /Mobile|Touch/.test(ua)) return true;
  return false;
}

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

  // CRITICAL: see /shortcut.plist route — request.url leaks internal
  // localhost:3000 under the custom Next.js server. Use the client-sent
  // Host header so the URL we bake into the redirect actually resolves
  // on the iPhone's network.
  const hostHeader = request.headers.get('host') ?? 'charging-master.local';
  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  const baseUrl = `${proto}://${hostHeader}`;
  const plistUrl = `${baseUrl}/api/devices/${plug.id}/shortcut.plist`;

  const ua = request.headers.get('user-agent');
  if (isIosUserAgent(ua)) {
    const name = `Charging-Master SoC ${plug.name}`;
    const target = `shortcuts://import-shortcut?url=${encodeURIComponent(plistUrl)}&name=${encodeURIComponent(name)}`;
    return new Response(null, {
      status: 302,
      headers: { Location: target },
    });
  }

  // Non-iOS: download the .plist so the user can inspect / AirDrop / curl.
  return new Response(null, {
    status: 302,
    headers: { Location: plistUrl },
  });
}
