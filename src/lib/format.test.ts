import { describe, it, expect } from 'vitest';
import { formatEnergy, formatDuration, formatDurationMinutes } from './format';

describe('formatEnergy', () => {
  it('returns Wh with no decimals below 1 kWh', () => {
    expect(formatEnergy(0)).toBe('0 Wh');
    expect(formatEnergy(7.4)).toBe('7 Wh');
    expect(formatEnergy(123)).toBe('123 Wh');
    expect(formatEnergy(999.4)).toBe('999 Wh');
  });

  it('flips to kWh with 2 decimals at 1000 Wh', () => {
    expect(formatEnergy(1000)).toBe('1.00 kWh');
    expect(formatEnergy(1722.8)).toBe('1.72 kWh');
    expect(formatEnergy(15_500)).toBe('15.50 kWh');
    expect(formatEnergy(999_999)).toBe('1000.00 kWh');
  });

  it('flips to MWh with 2 decimals at 1 000 000 Wh', () => {
    expect(formatEnergy(1_000_000)).toBe('1.00 MWh');
    expect(formatEnergy(1_720_500)).toBe('1.72 MWh');
    expect(formatEnergy(99_500_000)).toBe('99.50 MWh');
  });

  it('handles nullish and non-finite inputs gracefully', () => {
    expect(formatEnergy(null)).toBe('–');
    expect(formatEnergy(undefined)).toBe('–');
    expect(formatEnergy(NaN)).toBe('–');
    expect(formatEnergy(Infinity)).toBe('–');
  });

  it('handles negative values', () => {
    expect(formatEnergy(-500)).toBe('-500 Wh');
    expect(formatEnergy(-2500)).toBe('-2.50 kWh');
  });
});

describe('formatDuration', () => {
  it('formats minutes:seconds under one hour', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(45_000)).toBe('0:45');
    expect(formatDuration(125_000)).toBe('2:05');
  });

  it('formats hours:minutes:seconds at one hour and above', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });
});

describe('formatDurationMinutes', () => {
  it('returns plain minutes under one hour', () => {
    expect(formatDurationMinutes(0)).toBe('0 min');
    expect(formatDurationMinutes(60)).toBe('1 min');
    expect(formatDurationMinutes(45 * 60)).toBe('45 min');
  });

  it('flips to hours+minutes from one hour onwards', () => {
    expect(formatDurationMinutes(60 * 60)).toBe('1h 0min');
    expect(formatDurationMinutes(3_725)).toBe('1h 2min');
  });
});
