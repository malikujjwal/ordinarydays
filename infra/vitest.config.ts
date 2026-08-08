import { defineConfig } from 'vitest/config';

/**
 * The CDK assertion suite. In a phase where nothing is deployed, these tests are the only
 * thing standing between a written stack and a broken one.
 *
 * `infra`'s row in `testing.md` §9 is 70/60/70/70, but the row that matters more is
 * `definition-of-done.md` §3: "Assertions, not percentage". The named properties — log
 * retention on every log group, no VPC or NAT gateway, no public bucket, every alarm with
 * an SNS action — are asserted explicitly in `test/`, and the percentage is a backstop.
 */
export default defineConfig({
  test: {
    // Both, not just `test/`: `lib/config.test.ts` sits beside the module it tests, and
    // narrowing this to `test/**` silently dropped it and its seven assertions.
    include: ['lib/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    /**
     * CDK synthesis is not a cheap function call. `NodeLambda` runs **esbuild** at synth
     * time, so the first `Template.fromStack` in a file bundles a Lambda before it can
     * assert anything — and v8 coverage instrumentation pushes that past Vitest's 5-second
     * default. Two files started timing out the moment coverage was switched on in P0-24.
     *
     * A generous timeout is the honest fix here: the work is genuinely slow, and the
     * alternative — stubbing the bundler — would mean the tests no longer prove the
     * deployed artifact builds, which is most of the value of running synth at all.
     */
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      /**
       * Scoped to what this workspace authors. Without it the report includes the CDK
       * template output and the bundled Lambda under `cdk.out`, which is how `infra`
       * measured 23,994 statements before P0-24 — a number that says nothing about whether
       * the stacks are right.
       */
      include: ['lib/**/*.ts', 'lib/**/*.js', 'bin/**/*.ts'],
      exclude: ['**/*.test.ts', 'cdk.out/**', 'dist/**'],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
});
