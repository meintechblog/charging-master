import type { HttpPollingService } from '@/modules/shelly/http-polling-service';
import type { EventBus } from '@/modules/events/event-bus';
import type { ChargeMonitor } from '@/modules/charging/charge-monitor';

declare global {
  var __httpPollingService: HttpPollingService;
  var __eventBus: EventBus;
  var __chargeMonitor: ChargeMonitor;
}

export {};
