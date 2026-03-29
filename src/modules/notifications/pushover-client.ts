/**
 * Pushover API client - sends push notifications via Pushover HTTP API.
 */

export type PushoverMessage = {
  userKey: string;
  apiToken: string;
  title: string;
  message: string;
  priority: number;
};

/**
 * Send a push notification via Pushover API.
 * Returns true on success, false on failure.
 */
export async function sendPushover(msg: PushoverMessage): Promise<boolean> {
  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: msg.apiToken,
        user: msg.userKey,
        title: msg.title,
        message: msg.message,
        priority: msg.priority,
      }),
    });
    return res.ok;
  } catch (error) {
    console.error('Pushover send failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
