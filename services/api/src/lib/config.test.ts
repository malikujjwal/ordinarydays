import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `AUTH_MODE` startup guard (P1-02).
 *
 * ## Why every case re-imports the module
 *
 * The guard runs at **module scope**, not inside a function — that is the whole design, since
 * it is what makes it run during Lambda init and `tsx watch` startup rather than waiting for
 * a request. The consequence for tests is that the only way to exercise it is to import
 * `lib/config.ts` fresh under a given environment, so each case calls `vi.resetModules()` and
 * then `await import(...)`. A cached module would answer with the first case's environment
 * and the rest would pass without running the code they name.
 *
 * `vi.stubEnv` rather than assigning `process.env` directly, so `vi.unstubAllEnvs` restores
 * whatever the suite-wide environment in `vitest.config.ts` set.
 */

/** The variables `lib/config.ts` requires, minus the two each case is about. */
const BASE_ENV = {
  TABLE_NAME: 'od-main-local',
  MEDIA_BUCKET: 'od-media-local',
  WEB_ORIGINS: 'http://localhost:8081',
  LOG_LEVEL: 'fatal',
} as const;

function withEnv(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...env })) {
    if (value === undefined) vi.stubEnv(key, '');
    else vi.stubEnv(key, value);
  }
}

/** Imports `lib/config.ts` fresh, returning whatever it threw or resolved to. */
const importConfig = () => import('./config.js');

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('AUTH_MODE=local outside STAGE=local refuses to start', () => {
  /**
   * The failure this prevents: a deployed API running `LocalIdentityProvider`, answering as
   * the single constant `usr_local_dev` for every caller in the world, with no error, no
   * alarm and nothing in a log that looks wrong.
   */
  it.each(['dev', 'prod'])('throws when STAGE=%s', async (stage) => {
    withEnv({ STAGE: stage, AUTH_MODE: 'local' });

    await expect(importConfig()).rejects.toThrowError(
      /AUTH_MODE=local is only permitted when STAGE=local/,
    );
  });

  /** The message names both values, so the fix is obvious from the crash alone. */
  it.each(['dev', 'prod'])(
    'names AUTH_MODE and the offending STAGE=%s',
    async (stage) => {
      withEnv({ STAGE: stage, AUTH_MODE: 'local' });

      const error = await importConfig().catch((e: unknown) => e);
      expect(String(error)).toContain('AUTH_MODE=local');
      expect(String(error)).toContain(`STAGE=${stage}`);
      expect(String(error)).toContain('Refusing to start.');
    },
  );
});

describe('the permitted combinations start', () => {
  it('allows AUTH_MODE=local with STAGE=local — the laptop', async () => {
    withEnv({ STAGE: 'local', AUTH_MODE: 'local' });

    const mod = await importConfig();
    expect(mod.config.AUTH_MODE).toBe('local');
    expect(mod.config.STAGE).toBe('local');
  });

  /**
   * **The guard is one-directional and must stay that way.** `cognito` on a laptop is how
   * Phase 4 lets a developer sign in against the deployed dev user pool from their machine.
   * A symmetric check would break that, which is why it is asserted rather than assumed.
   */
  it('allows AUTH_MODE=cognito with STAGE=local — signing in against a deployed pool', async () => {
    withEnv({ STAGE: 'local', AUTH_MODE: 'cognito' });

    const mod = await importConfig();
    expect(mod.config.AUTH_MODE).toBe('cognito');
  });

  it('allows AUTH_MODE=cognito on a deployed stage', async () => {
    withEnv({ STAGE: 'prod', AUTH_MODE: 'cognito' });

    const mod = await importConfig();
    expect(mod.config.AUTH_MODE).toBe('cognito');
  });
});

describe('AUTH_MODE has no default', () => {
  /**
   * An unset value fails the Zod parse rather than falling back. A default of `local` is the
   * dangerous one and a default of `cognito` is merely inconvenient, so neither is worth the
   * ambiguity — every environment states its mode.
   */
  it('throws from the parse, naming the variable', async () => {
    withEnv({ STAGE: 'local', AUTH_MODE: undefined });

    const error = await importConfig().catch((e: unknown) => e);
    expect(String(error)).toContain('Invalid environment');
    expect(String(error)).toContain('AUTH_MODE');
  });

  it('rejects a mode that is not one of the two', async () => {
    withEnv({ STAGE: 'local', AUTH_MODE: 'dev-bypass' });

    await expect(importConfig()).rejects.toThrowError(/AUTH_MODE/);
  });
});

describe('the guard reads STAGE, not NODE_ENV', () => {
  /**
   * `NODE_ENV` is `production` inside a bundled Lambda *and* commonly in a local
   * production-mode build, so it does not name the environment. `STAGE` does. Asserted by
   * showing that a hostile `NODE_ENV` changes nothing in either direction.
   */
  it('starts on a laptop whatever NODE_ENV says', async () => {
    withEnv({ STAGE: 'local', AUTH_MODE: 'local', NODE_ENV: 'production' });

    await expect(importConfig()).resolves.toBeDefined();
  });

  it('still refuses on a deployed stage whatever NODE_ENV says', async () => {
    withEnv({ STAGE: 'prod', AUTH_MODE: 'local', NODE_ENV: 'development' });

    await expect(importConfig()).rejects.toThrowError(/Refusing to start/);
  });
});
