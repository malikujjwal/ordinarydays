import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { GITHUB_REPO, getConfig } from '../lib/config.js';
import { AccountStack } from '../lib/stacks/account-stack.js';

const template = (() => {
  const app = new cdk.App();
  const stack = new AccountStack(app, 'od-account', {
    alertEmail: getConfig('prod').alertEmail,
    githubRepo: GITHUB_REPO,
  });
  return Template.fromStack(stack);
})();

describe('budgets', () => {
  it('creates exactly two, which is the account free allowance', () => {
    template.resourceCountIs('AWS::Budgets::Budget', 2);
  });

  it.each([
    ['od-monthly-warn', 5],
    ['od-monthly-stop', 20],
  ])('%s is a monthly cost budget of $%i', (budgetName, amount) => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetName: budgetName,
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: amount, Unit: 'USD' },
      }),
    });
  });

  it('notifies a subscriber on both actual and forecast breach', () => {
    const found = Object.values(template.findResources('AWS::Budgets::Budget')) as Array<{
      Properties: {
        NotificationsWithSubscribers: Array<{
          Notification: { NotificationType: string };
          Subscribers: Array<{ SubscriptionType: string; Address: string }>;
        }>;
      };
    }>;

    expect(found).toHaveLength(2);
    for (const budget of found) {
      const notifications = budget.Properties.NotificationsWithSubscribers;
      expect(notifications.map((n) => n.Notification.NotificationType).sort()).toEqual([
        'ACTUAL',
        'FORECASTED',
      ]);
      // A budget with no subscriber is a budget nobody hears about.
      for (const n of notifications) {
        expect(n.Subscribers.length).toBeGreaterThan(0);
        expect(n.Subscribers[0]?.SubscriptionType).toBe('EMAIL');
      }
    }
  });
});

describe('cost anomaly detection', () => {
  it('monitors every service', () => {
    template.hasResourceProperties('AWS::CE::AnomalyMonitor', {
      MonitorType: 'DIMENSIONAL',
      MonitorDimension: 'SERVICE',
    });
  });

  // CloudFormation only permits IMMEDIATE with an SNS subscriber; email must be
  // DAILY or WEEKLY. Getting this wrong fails at deploy, not at synth.
  it('uses a frequency that is valid for an email subscriber', () => {
    template.hasResourceProperties('AWS::CE::AnomalySubscription', {
      Frequency: Match.stringLikeRegexp('^(DAILY|WEEKLY)$'),
      Subscribers: [{ Type: 'EMAIL', Address: Match.anyValue() }],
    });
  });
});

describe('the GitHub OIDC trust policy', () => {
  const roles = () =>
    Object.values(template.findResources('AWS::IAM::Role')).filter((r) =>
      JSON.stringify(r).includes('token.actions.githubusercontent.com'),
    ) as Array<{ Properties: { RoleName: string; AssumeRolePolicyDocument: unknown } }>;

  it('creates one deploy role per stage', () => {
    expect(
      roles()
        .map((r) => r.Properties.RoleName)
        .sort(),
    ).toEqual(['od-github-deploy-dev', 'od-github-deploy-prod']);
  });

  // The single most important assertion in this file. A trust policy carrying only the
  // `aud` condition lets ANY GitHub repository in the world assume the role.
  it('constrains the sub claim to this repository on every role', () => {
    for (const role of roles()) {
      const doc = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
      expect(doc).toContain('token.actions.githubusercontent.com:sub');
      expect(doc).toContain(`repo:${GITHUB_REPO}:`);
    }
  });

  it('never leaves the sub claim open to every repository', () => {
    for (const role of roles()) {
      const doc = role.Properties.AssumeRolePolicyDocument as {
        Statement: Array<{ Condition?: Record<string, Record<string, string>> }>;
      };
      for (const statement of doc.Statement) {
        for (const operator of Object.values(statement.Condition ?? {})) {
          const sub = operator['token.actions.githubusercontent.com:sub'];
          if (sub === undefined) continue;
          expect(sub.startsWith(`repo:${GITHUB_REPO}:`)).toBe(true);
          expect(sub).not.toBe('*');
          expect(sub).not.toBe(`repo:${GITHUB_REPO}:*`);
        }
      }
    }
  });

  it('pins the audience to sts.amazonaws.com on every role', () => {
    for (const role of roles()) {
      const doc = role.Properties.AssumeRolePolicyDocument as {
        Statement: Array<{ Condition?: { StringEquals?: Record<string, string> } }>;
      };
      const auds = doc.Statement.map(
        (s) => s.Condition?.StringEquals?.['token.actions.githubusercontent.com:aud'],
      );
      expect(auds).toContain('sts.amazonaws.com');
    }
  });

  // A branch-scoped prod role can be triggered by anything that can push to that branch.
  // The GitHub environment gate, with a required reviewer, is what mints the credential.
  it('scopes prod to the production environment rather than a branch', () => {
    const prod = roles().find((r) => r.Properties.RoleName === 'od-github-deploy-prod');
    const doc = JSON.stringify(prod?.Properties.AssumeRolePolicyDocument);
    expect(doc).toContain(`repo:${GITHUB_REPO}:environment:production`);
    expect(doc).not.toContain('refs/heads');
  });
});

describe('permissions', () => {
  it('grants no statement of * on *', () => {
    for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
      const doc = policy.Properties.PolicyDocument as {
        Statement: Array<{ Effect: string; Action: unknown; Resource: unknown }>;
      };
      for (const s of doc.Statement) {
        const actions = [s.Action].flat();
        const resources = [s.Resource].flat();
        expect(actions).not.toContain('*');
        expect(resources).not.toContain('*');
      }
    }
  });

  it('lets each role reach only its own stage in CloudFormation', () => {
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('stack/od-*-dev/*');
    expect(policies).toContain('stack/od-*-prod/*');
  });
});
