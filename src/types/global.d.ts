import type { MqttService } from '@/modules/mqtt/mqtt-service';
import type { EventBus } from '@/modules/events/event-bus';
import type { DiscoveredDevice } from '@/modules/mqtt/discovery';
import type { ChargeSessionData } from '@/modules/charging/types';

interface ChargeMonitorLike {
  startLearning(plugId: string, sessionId: number): void;
  stopLearning(plugId: string): void;
  abortSession(plugId: string): void;
  overrideSession(sessionId: number, opts: { profileId?: number; targetSoc?: number }): void;
  getSessionData(plugId: string): ChargeSessionData | null;
  getActiveSessions(): ChargeSessionData[];
}

declare global {
  var __mqttService: MqttService;
  var __eventBus: EventBus;
  var __discoveredDevices: Map<string, DiscoveredDevice>;
  var __chargeMonitor: ChargeMonitorLike | undefined;
}

export {};
