/**
 * Pushover API client - sends push notifications via Pushover HTTP API.
 */

export type PushoverMessage = {
  userKey: string;
  apiToken: string;
  title: string;
  message: string;
  priority: number;
  /** Render message body in monospace font (Pushover v3.4+).
   *  Mutually exclusive with html=1.
   *  Phase 11-03 SOCB-05: opt-in for messages that embed the ASCII SOC band.
   *  Legacy callers omit this and the field is NOT included in the request body.
   *  Source: https://pushover.net/api */
  monospace?: 0 | 1;
};

/**
 * Send a push notification via Pushover API.
 * Returns true on success, false on failure.
 */
export async function sendPushover(msg: PushoverMessage): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      token: msg.apiToken,
      user: msg.userKey,
      title: msg.title,
      message: msg.message,
      priority: msg.priority,
    };
    if (msg.monospace) body.monospace = 1;

    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (error) {
    console.error('Pushover send failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
