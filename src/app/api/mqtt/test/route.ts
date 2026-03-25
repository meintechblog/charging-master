export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { host, port, username, password } = body as {
      host: unknown;
      port?: unknown;
      username?: unknown;
      password?: unknown;
    };

    if (typeof host !== 'string' || host.trim() === '') {
      return Response.json({ error: 'invalid_input' }, { status: 400 });
    }

    const brokerPort = typeof port === 'number' ? port : 1883;
    const brokerUrl = `mqtt://${host}:${brokerPort}`;

    const options: Record<string, unknown> = {};
    if (typeof username === 'string' && username.length > 0) {
      options.username = username;
    }
    if (typeof password === 'string' && password.length > 0) {
      options.password = password;
    }

    const mqttService = globalThis.__mqttService;
    if (!mqttService) {
      return Response.json(
        { success: false, error: 'MQTT service not initialized' },
        { status: 500 },
      );
    }

    const success = await mqttService.testConnection(brokerUrl, options);
    return Response.json({ success });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
