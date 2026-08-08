import { defineConfig } from 'vitest/config';

/**
 * The root project list, so `vitest` from the repository root runs every workspace's suite
 * and an editor can discover all of them from one place.
 *
 * **This is not where the gates are enforced.** Each package's own `vitest.config.ts` holds
 * its thresholds from `testing.md` §9, and `turbo run test` runs those configs — which is
 * what `pnpm test` and CI do. Coverage in Vitest is one report for the whole run, so a
 * root-level run cannot apply per-package floors; putting them here would produce a single
 * blended number that lets a well-covered package carry a poorly covered one.
 *
 * `projects` rather than a `vitest.workspace.ts` file, which `phase-00-foundations.md`
 * P0-24 names: workspace files are deprecated as of Vitest 3.2 in favour of this field, and
 * this repository is on 3.2.7.
 *
 * `services/api`'s integration suite is deliberately absent — it needs DynamoDB Local, and
 * `pnpm test` must run with nothing but Node installed. It is a separate Turbo task,
 * `test:int`, from its own config.
 */
export default defineConfig({
  test: {
    projects: ['packages/shared', 'packages/ui', 'services/api', 'infra', 'apps/mobile'],
  },
});
