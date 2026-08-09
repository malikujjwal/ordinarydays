import { z } from 'zod';

/**
 * The **only** place in this service that reads `process.env` (`repo-structure.md` §2.4).
 *
 * Parsed with Zod at module load, so a missing or malformed variable is a cold-start crash
 * with a named field rather than an `undefined` that surfaces as a confusing runtime error
 * three layers down. Environment variables hold identifiers only — never a secret
 * (`security-privacy.md` §6.2).
 */
const envSchema = z.object({
  STAGE: z.enum(['local', 'dev', 'prod']),
  /**
   * Which `IdentityProvider` the API runs (`middleware/identity.ts`, P1-01).
   *
   * **No default, deliberately.** An unset value throws at startup. A default of `local` is
   * dangerous — a deployed API treating every caller in the world as `usr_local_dev` — and a
   * default of `cognito` is merely inconvenient, so neither is worth the ambiguity: every
   * environment states which mode it is in.
   *
   * This and `middleware/identity.ts` are the **only two files** permitted to mention
   * `AUTH_MODE`; everything else reads `c.get('userId')` and knows nothing about how it got
   * there. `node scripts/check-forbidden.mjs auth-mode-containment` enforces it.
   */
  AUTH_MODE: z.enum(['local', 'cognito']),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  TABLE_NAME: z.string().min(1),
  MEDIA_BUCKET: z.string().min(1),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  /**
   * Set only on a laptop, pointing at DynamoDB Local. Its presence is the **one** permitted
   * local-vs-deployed branch in runtime code (`phase-00-foundations.md` P0-13).
   */
  DDB_ENDPOINT: z.string().url().optional(),
  /** Stamped at deploy time from Phase 4 onward; `local` on a laptop. */
  GIT_SHA: z.string().default('local'),
  /** Comma-separated. Empty until Phase 5 registers the domain. */
  WEB_ORIGINS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Exported as a function of the raw environment so tests can build a config without
 * mutating `process.env`, and so the parse failure is reproducible.
 */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${fields}`);
  }
  return result.data;
}

export const config: Config = parseConfig(process.env);
