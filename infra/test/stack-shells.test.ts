import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { getConfig, STAGES } from '../lib/config.js';
import { ApiStack } from '../lib/stacks/api-stack.js';
import { AuthStack } from '../lib/stacks/auth-stack.js';
import { DataStack } from '../lib/stacks/data-stack.js';
import { DnsStack } from '../lib/stacks/dns-stack.js';
import { SchedulerStack } from '../lib/stacks/scheduler-stack.js';

/**
 * The three shells: `DnsStack` (P5-01), `AuthStack` (P4-08, P4-10) and `SchedulerStack`
 * (P5-12). They exist so those tasks have a place to land, and their only asserted property
 * is that they are still empty.
 *
 * That sounds like a test of nothing. It is the opposite: emptiness is the one shape that
 * changes without anyone deciding to change it — a construct added to the wrong file, a
 * copy-paste from a filled stack — and it changes silently, because a shell with an
 * unintended resource still synthesises and still passes every other test in this suite.
 *
 * **What the deployed template holds is not what this file sees.** `Template.fromStack`
 * synthesises its own `App`, so it never applies `cdk.json`'s `versionReporting`, and the
 * shells come out with no `Resources` key at all. The CLI does apply it: the templates in
 * `cdk.out` each carry one `AWS::CDK::Metadata` resource. That difference has a consequence
 * worth knowing before Phase 4 — the CLI skips a stack whose `Resources` is empty ("stack
 * has no resources, skipping deployment"), but the metadata resource makes the count 1, so
 * `cdk deploy 'od-*-dev'` would create three CloudFormation stacks containing nothing.
 * Harmless and free, and the reason **P4-05 excludes them from the dev deploy set
 * explicitly** rather than trusting CDK to notice. The same CLI branch has a sharper edge
 * later: emptying a stack that already exists makes CDK *delete* it.
 */
function build(stage: 'dev' | 'prod') {
  const app = new cdk.App();
  const cfg = getConfig(stage);
  const dns = new DnsStack(app, `od-dns-${stage}`, { cfg });
  const auth = new AuthStack(app, `od-auth-${stage}`, { cfg, dns });
  const data = new DataStack(app, `od-data-${stage}`, { cfg });
  const api = new ApiStack(app, `od-api-${stage}`, { cfg, dns, auth, data });
  const scheduler = new SchedulerStack(app, `od-scheduler-${stage}`, { cfg, data, api });
  return { dns, auth, scheduler };
}

const built = { dev: build('dev'), prod: build('prod') };

const resourceTypes = (stack: cdk.Stack): string[] =>
  Object.values(
    (Template.fromStack(stack).toJSON().Resources ?? {}) as Record<
      string,
      { Type: string }
    >,
  ).map((r) => r.Type);

describe.each(STAGES)('the shells in %s', (stage) => {
  const shells = [
    ['DnsStack', built[stage].dns],
    ['AuthStack', built[stage].auth],
    ['SchedulerStack', built[stage].scheduler],
  ] as const;

  it.each(shells)('%s holds no resource', (_name, stack) => {
    expect(resourceTypes(stack)).toEqual([]);
  });

  /**
   * The resource types each shell will own once it is filled (`infrastructure.md` §1.1).
   * Named explicitly rather than left to the count above, so a failure says *what* landed
   * early rather than only that something did.
   */
  it.each(shells)('%s emits nothing it is scheduled to gain later', (_name, stack) => {
    const emitted = resourceTypes(stack).join(' ');
    for (const prefix of [
      'AWS::CertificateManager::',
      'AWS::Route53::',
      'AWS::Cognito::',
      'AWS::Scheduler::',
      'AWS::Events::',
      'AWS::Lambda::',
    ]) {
      expect(emitted).not.toContain(prefix);
    }
  });
});

describe('DnsStack as the other stacks see it', () => {
  /**
   * The shell's actual contract, and the reason it is not merely an empty file. `ApiStack`
   * and `WebStack` each gate their custom-domain branch on the **certificate construct**
   * being present rather than on a config string, because CloudFormation orders a
   * certificate before the thing that uses it only when there is a real dependency edge
   * between them (P0-15, P0-16). Both fields being `undefined` here is what makes those
   * branches skip, and therefore what lets the whole app synthesise before a domain exists.
   */
  it('offers both certificates as undefined while no domain is registered', () => {
    for (const stage of STAGES) {
      expect(getConfig(stage).domain).toBeUndefined();
      expect(built[stage].dns.apiCertificate).toBeUndefined();
      expect(built[stage].dns.edgeCertificate).toBeUndefined();
    }
  });
});
