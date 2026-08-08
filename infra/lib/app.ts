import * as cdk from 'aws-cdk-lib';
import { GITHUB_REPO, getConfig, STAGES } from './config.js';
import { AccountStack } from './stacks/account-stack.js';
import { ApiStack } from './stacks/api-stack.js';
import { AuthStack } from './stacks/auth-stack.js';
import { DataStack } from './stacks/data-stack.js';
import { DnsStack } from './stacks/dns-stack.js';
import { ObservabilityStack } from './stacks/observability-stack.js';
import { SchedulerStack } from './stacks/scheduler-stack.js';
import { WebStack } from './stacks/web-stack.js';
import { applyAppTags } from './tags.js';

/**
 * Builds the whole CDK app: eight stacks, one account-scoped singleton and seven per stage.
 *
 * **Stacks are environment-agnostic in Phase 0 — no `env` prop.** `infrastructure.md` §1.2's
 * snippet sets `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' }`, but
 * P0-09 forbids exactly that: CI has no AWS role in this phase, so an `env` whose account is
 * undefined at synth is a synth that only works on a machine with credentials configured.
 * Phase 4 pins the environment when it first deploys. §1.2 is amended to say so.
 *
 * For the same reason no stack here may call `HostedZone.fromLookup`, `Vpc.fromLookup` or
 * any other context lookup **while CI synthesises without credentials**, which is every
 * phase up to 4. A lookup added carelessly turns a green CI job into one that passes only
 * on the founder's laptop. P5-01 introduces the first one deliberately, once the zone
 * exists and CI has a deploy role, together with the `cdk.context.json` it writes.
 *
 * The stage comes from the **stack name** (`cdk deploy 'od-*-dev'`), never from a `-c stage=`
 * context flag, so there is no way to synth dev config into a prod stack name.
 *
 * **Extracted from `bin/ordinarydays.ts` in P0-26**, so that `test/all-stacks.test.ts` can
 * sweep the real app rather than a second hand-maintained list of stacks. A sweep that
 * enumerated its own stacks would protect exactly the stacks somebody remembered to add to
 * it, which is the opposite of what a cross-cutting invariant is for — the whole point is
 * that a stack added in Phase 4 inherits every one of them without being told.
 */
export interface BuildAppOptions {
  /**
   * The web export to upload, relative to the workspace root. Defaults to where
   * `expo export --platform web` writes.
   *
   * Exists so a test can pin it. `WebStack` skips its `BucketDeployment` when the directory
   * is absent, so whether the app contains that deployment — and the Lambda, role and
   * policy CDK generates with it — depends on whether anyone has run a build. A sweep over
   * "every resource in the app" would otherwise assert over a different set of resources on
   * a laptop than in CI, which is a test that changes its mind based on untracked state.
   */
  webSourcePath?: string;
}

export function buildApp(options: BuildAppOptions = {}): cdk.App {
  const app = new cdk.App();

  applyAppTags(app);

  // Account-scoped, so it takes no stage. `alertEmail` is read from the prod config only
  // because both stages carry the same address and account-wide alerts belong to neither.
  new AccountStack(app, 'od-account', {
    alertEmail: getConfig('prod').alertEmail,
    githubRepo: GITHUB_REPO,
  });

  for (const stage of STAGES) {
    const cfg = getConfig(stage);

    // Cross-stack references are typed construct props, never `Fn::ImportValue` strings.
    // Within one app, one account and one region, CDK turns these into exports itself and
    // orders the deploys correctly. The rule that matters: a stateful resource is never
    // referenced by name-string from another stack (§1.2).
    const dns = new DnsStack(app, `od-dns-${stage}`, { cfg });
    const auth = new AuthStack(app, `od-auth-${stage}`, { cfg, dns });
    const data = new DataStack(app, `od-data-${stage}`, { cfg });
    const api = new ApiStack(app, `od-api-${stage}`, { cfg, dns, auth, data });
    new WebStack(app, `od-web-${stage}`, {
      cfg,
      dns,
      data,
      ...(options.webSourcePath === undefined
        ? {}
        : { webSourcePath: options.webSourcePath }),
    });
    const scheduler = new SchedulerStack(app, `od-scheduler-${stage}`, {
      cfg,
      data,
      api,
    });
    // `data` was added to these props in P0-17: `ddb-throttles` watches the table, and a
    // stateful resource is never referenced across stacks by name-string (§1.2).
    new ObservabilityStack(app, `od-observability-${stage}`, {
      cfg,
      api,
      data,
      scheduler,
    });
  }

  return app;
}
