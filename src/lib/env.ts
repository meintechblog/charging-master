import { z } from 'zod/v4';

const envSchema = z.object({
  DATABASE_PATH: z.string().default('data/charging-master.db'),
  PORT: z.coerce.number().default(3000),
});

export const env = envSchema.parse(process.env);

// Catalog-App-Vars sind optional — fehlend → auto-sync deaktiviert sich
// gracefully (CONTEXT.md decisions/Env Vars). Daher safeParse statt parse:
// kein Boot-Crash wenn die App ohne Catalog-Auto-Sync laufen soll.
const catalogAppEnvSchema = z
  .object({
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_INSTALLATION_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    CATALOG_REPO_OWNER: z.string().min(1),
    CATALOG_REPO_NAME: z.string().min(1),
  })
  .refine(
    (v) => Boolean(v.GITHUB_APP_PRIVATE_KEY) !== Boolean(v.GITHUB_APP_PRIVATE_KEY_PATH),
    { message: 'exactly one of GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH must be set' },
  );

export type CatalogAppEnv = z.infer<typeof catalogAppEnvSchema>;

const catalogAppParsed = catalogAppEnvSchema.safeParse(process.env);
export const catalogAppEnv: CatalogAppEnv | null = catalogAppParsed.success ? catalogAppParsed.data : null;
export const catalogAppEnvError: string | null = catalogAppParsed.success
  ? null
  : catalogAppParsed.error.issues[0]?.message ?? 'invalid catalog app env';
