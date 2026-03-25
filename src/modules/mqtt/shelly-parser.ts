import { z } from 'zod/v4';

const ShellyEnergySchema = z.object({
  total: z.number(),
  by_minute: z.array(z.number()).optional(),
  minute_ts: z.number().optional(),
});

const ShellySwitchStatusSchema = z.object({
  id: z.number(),
  source: z.string().optional(),
  output: z.boolean(),
  apower: z.number(),
  voltage: z.number(),
  current: z.number(),
  pf: z.number().optional(),
  freq: z.number().optional(),
  aenergy: ShellyEnergySchema,
  temperature: z.object({
    tC: z.number(),
    tF: z.number(),
  }).optional(),
});

export { ShellyEnergySchema, ShellySwitchStatusSchema };
export type ShellySwitchStatus = z.infer<typeof ShellySwitchStatusSchema>;

export function parseShellyStatus(payload: string): ShellySwitchStatus | null {
  try {
    const parsed = JSON.parse(payload);
    const result = ShellySwitchStatusSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
