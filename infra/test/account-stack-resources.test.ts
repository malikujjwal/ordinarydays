import * as cdk from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { GITHUB_REPO, getConfig } from '../lib/config.js';
import { AccountStack } from '../lib/stacks/account-stack.js';

/**
 * What this stack is *made of*, asserted directly.
 *
 * `cost-model.md` §2.13 prices this stack, and the price depends on the resource inventory:
 * the first two budgets in an account are free, Cost Anomaly Detection is free, and IAM is
 * free at any scale. An extra budget or an unexpected Lambda changes the answer, so the
 * inventory is pinned rather than described.
 */
const app = new cdk.App();
new AccountStack(app, 'od-account', {
  alertEmail: getConfig('prod').alertEmail,
  githubRepo: GITHUB_REPO,
});
const resources = app.synth().getStackByName('od-account').template.Resources as Record<
  string,
  { Type: string }
>;

/**
 * `AWS::CDK::Metadata` is excluded: it is a synth artefact the CLI adds for version
 * reporting, it is free, and it is absent when an `App` is constructed in-process, so
 * including it would make this assertion depend on how the test was invoked.
 */
const countByType = (): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const { Type } of Object.values(resources)) {
    if (Type === 'AWS::CDK::Metadata') continue;
    counts[Type] = (counts[Type] ?? 0) + 1;
  }
  return counts;
};

describe('resource inventory', () => {
  it('is exactly what cost-model.md §2.13 prices', () => {
    expect(countByType()).toEqual({
      'AWS::Budgets::Budget': 2,
      'AWS::CE::AnomalyMonitor': 1,
      'AWS::CE::AnomalySubscription': 1,
      'AWS::IAM::OIDCProvider': 1,
      'AWS::IAM::Policy': 2,
      'AWS::IAM::Role': 2,
    });
  });

  /**
   * The `OpenIdConnectProvider` L2 that §3.8 shows provisions a
   * `Custom::AWSCDKOpenIdConnectProvider` backed by a Lambda and a third IAM role. Native
   * CloudFormation support exists now, so none of that is needed — and a standing function
   * holding `iam:CreateOpenIDConnectProvider` is not something to carry by accident.
   */
  it('carries no Lambda and no custom resource', () => {
    const types = Object.values(resources).map((r) => r.Type);
    expect(types.filter((t) => t === 'AWS::Lambda::Function')).toEqual([]);
    expect(types.filter((t) => t.startsWith('Custom::'))).toEqual([]);
  });

  // Every additional budget beyond the second costs ~$0.02/day. Three budgets is already
  // the accepted position (§2.13) because P0-03's console budget is the live guard; a
  // fourth would be a new recurring charge nobody decided on.
  it('adds no third budget', () => {
    expect(countByType()['AWS::Budgets::Budget']).toBe(2);
  });
});
