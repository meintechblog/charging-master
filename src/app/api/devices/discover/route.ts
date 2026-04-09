import { scanSubnet } from '@/modules/shelly/discovery-scanner';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const devices = await scanSubnet();
    return Response.json({ devices });
  } catch (err) {
    console.error('Subnet scan failed:', err);
    return Response.json(
      { error: 'scan_failed', devices: [] },
      { status: 500 }
    );
  }
}
