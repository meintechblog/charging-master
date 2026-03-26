import type { MqttService } from '@/modules/mqtt/mqtt-service';
import type { EventBus } from '@/modules/events/event-bus';
import type { DiscoveredDevice } from '@/modules/mqtt/discovery';
import type { ChargeMonitor } from '@/modules/charging/charge-monitor';

declare global {
  var __mqttService: MqttService;
  var __eventBus: EventBus;
  var __discoveredDevices: Map<string, DiscoveredDevice>;
  var __chargeMonitor: ChargeMonitor;
}

export {};
