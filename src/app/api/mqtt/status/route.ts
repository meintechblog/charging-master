export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const mqttService = globalThis.__mqttService;
  return Response.json({
    connected: mqttService?.isConnected() ?? false,
  });
}
