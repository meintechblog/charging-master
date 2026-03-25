import type { MqttService } from '@/modules/mqtt/mqtt-service';
import type { EventBus } from '@/modules/events/event-bus';
import type { DiscoveredDevice } from '@/modules/mqtt/discovery';

declare global {
  var __mqttService: MqttService;
  var __eventBus: EventBus;
  var __discoveredDevices: Map<string, DiscoveredDevice>;
}

export {};
