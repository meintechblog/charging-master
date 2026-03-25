// Stub -- full implementation in Task 2
import type { EventBus } from '../events/event-bus';

export class MqttService {
  constructor(_eventBus: EventBus) {}
  async connect(_brokerUrl: string): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return false; }
}
