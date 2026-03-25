export const runtime = 'nodejs';

export async function GET() {
  const mqttService = globalThis.__mqttService;

  if (!mqttService || !mqttService.isConnected()) {
    return Response.json(
      { error: 'mqtt_not_connected', devices: [] },
      { status: 503 },
    );
  }

  const discoveredMap = globalThis.__discoveredDevices;
  if (!discoveredMap) {
    return Response.json({ devices: [] });
  }

  const devices = Array.from(discoveredMap.values());
  return Response.json({ devices });
}
