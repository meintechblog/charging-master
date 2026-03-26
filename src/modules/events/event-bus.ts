import { EventEmitter } from 'events';
import type { ChargeStateEvent } from '@/modules/charging/types';

export interface PowerReading {
  plugId: string;
  apower: number;
  voltage: number;
  current: number;
  output: boolean;
  totalEnergy: number;
  timestamp: number;
}

export interface PlugOnlineEvent {
  plugId: string;
  online: boolean;
}

export class EventBus extends EventEmitter {
  emitPowerReading(reading: PowerReading) {
    this.emit(`power:${reading.plugId}`, reading);
    this.emit('power:*', reading);
  }

  emitPlugOnline(plugId: string, online: boolean) {
    this.emit(`online:${plugId}`, { plugId, online });
    this.emit('online:*', { plugId, online });
  }

  emitDiscoveredDevice(deviceId: string) {
    this.emit('discovery:device', deviceId);
  }

  emitChargeState(event: ChargeStateEvent) {
    this.emit(`charge:${event.plugId}`, event);
    this.emit('charge:*', event);
  }
}
