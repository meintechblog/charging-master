/**
 * Shared formatting utilities for duration, energy, and power values.
 */

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hours > 0) return `${hours}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Smart energy formatter — auto-scales unit so the number stays in a
 * human-readable range.
 *
 *   < 1 kWh         → 123 Wh         (integer, no decimals)
 *   1–999 kWh       → 4.28 kWh       (2 decimals)
 *   ≥ 1 MWh         → 1.72 MWh       (2 decimals)
 *
 * Plain Wh under 1 kWh gets no decimals because the smart-plug noise floor
 * (~0.1 Wh) makes them meaningless and they crowd the UI ("1722.80 Wh").
 */
export function formatEnergy(wh: number | null | undefined): string {
  if (wh == null || !Number.isFinite(wh)) return '–';
  const abs = Math.abs(wh);
  if (abs >= 1_000_000) return `${(wh / 1_000_000).toFixed(2)} MWh`;
  if (abs >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
  return `${Math.round(wh)} Wh`;
}

export function formatDurationMinutes(seconds: number): string {
  const min = Math.floor(seconds / 60);
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}min`;
  return `${min} min`;
}
