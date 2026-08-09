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

/**
 * **`AUTH_MODE=local` is only permitted when `STAGE=local`.** A throw, at module load,
 * before any request is served (P1-02).
 *
 * ## What this stands between
 *
 * `LocalIdentityProvider` returns the constant `usr_local_dev` for every caller. Running it
 * in a deployed environment means a single shared account holding everybody's data, and an
 * API that returns `200` to the entire internet. That failure is **completely silent**: no
 * error, no alarm, no unusual latency, nothing in a log that looks wrong. It would be found
 * by someone noticing their data was not theirs.
 *
 * So it is a throw and not a warning. A warning is one line in a log nobody reads; a throw
 * during init fails every invocation immediately, trips `ObservabilityStack`'s `api-errors`
 * alarm on the first request, and presents as a failed deploy rather than as a breach found
 * later.
 *
 * ## Why here, and why at module scope
 *
 * `lib/config.ts` is imported by `app.ts`, which is imported by both `index.ts` and
 * `local.ts` — so this runs during Lambda **init** and during `tsx watch` startup. It cannot
 * be skipped, deferred or reached around, and it does not wait for a request. Keeping it in
 * this module rather than in `middleware/identity.ts` also guarantees it runs **before**
 * `identityProvider` is constructed, regardless of import order.
 *
 * ## One-directional, deliberately
 *
 * `AUTH_MODE=cognito` with `STAGE=local` is **allowed**, and is exactly how Phase 4 lets a
 * developer sign in against the deployed dev user pool from a laptop. Do not make the check
 * symmetric.
 *
 * It reads `STAGE` and not `NODE_ENV`: `NODE_ENV` is `production` inside a bundled Lambda
 * *and* commonly in a local production-mode build, so it does not name the environment.
 * `STAGE` does.
 *
 * ## Two more mechanisms, in other files
 *
 * This is one of three (P1-02's defence-in-depth table), because it is the one place in the
 * project where a single missed check has an unbounded consequence:
 *
 * 1. this throw — fails at runtime, during init;
 * 2. `ApiStack` hard-codes `AUTH_MODE: 'cognito'` and never accepts it as a parameter —
 *    fails at synth;
 * 3. a CDK sweep asserting no synthesised function carries `AUTH_MODE: 'local'` — fails in
 *    CI (`infra/test/all-stacks.test.ts`).
 */
if (config.AUTH_MODE === 'local' && config.STAGE !== 'local') {
  throw new Error(
    `AUTH_MODE=local is only permitted when STAGE=local. ` +
      `STAGE=${config.STAGE}. Refusing to start.`,
  );
}
