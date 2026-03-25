export const DISCOVERY_TOPICS = [
  '+/online',
  '+/status/switch:0',
];

export type DiscoveredDevice = {
  deviceId: string;
  firstSeen: number;
  lastSeen: number;
  online: boolean;
};

export function parseDeviceId(topic: string): string {
  return topic.split('/')[0];
}

export function isDiscoveryTopic(topic: string): boolean {
  return DISCOVERY_TOPICS.some((pattern) => {
    const regex = new RegExp('^' + pattern.replace('+', '[^/]+') + '$');
    return regex.test(topic);
  });
}
