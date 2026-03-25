import { z } from 'zod/v4';

const envSchema = z.object({
  DATABASE_PATH: z.string().default('data/charging-master.db'),
  PORT: z.coerce.number().default(3000),
});

export const env = envSchema.parse(process.env);
