import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { ANOMALY_THRESHOLD_USD, BUDGET_USD } from '../config.js';
import { applyStackTags } from '../tags.js';

/**
 * `od-account` — account-scoped, environment-independent (`infrastructure.md` §1.1,
 * adjustment 2). Deployed **once**, not per stage: an IAM OIDC provider for
 * `token.actions.githubusercontent.com` can exist only once per account, and budgets track
 * total account spend. Duplicating either per stage is a deploy conflict on the second one.
 *
 * **Written and synthesised only in Phase 0. Not deployed.** The console budget from P0-03
 * is the live guard until Phase 4; P0-31 deploys the OIDC half temporarily and then decides
 * what to keep.
 *
 * Cost (`cost-model.md` §2.13): the first two budgets in an account are free, and Cost
 * Anomaly Detection is free. IAM has no charge at any scale. The account will run **three**
 * budgets once this deploys — these two plus P0-03's `od-bootstrap-zero-spend` — and the
 * third costs ~$0.02/day, about $0.60/month. §2.13 anticipates exactly that and calls it
 * the correct trade. Nothing here carries an hourly charge.
 */
export interface AccountStackProps extends cdk.StackProps {
  /** Where budget and anomaly notifications go. */
  readonly alertEmail: string;
  /** `owner/repo` allowed to assume the deploy roles. */
  readonly githubRepo: string;
}

export class AccountStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AccountStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'account');

    this.addBudgets(props.alertEmail);
    this.addAnomalyDetection(props.alertEmail);
    this.addGithubDeployRoles(props.githubRepo);
  }

  /**
   * Two monthly cost budgets: `warn` is "something changed", `stop` is "something is
   * wrong". Each notifies on actual spend crossing its limit and on the month being
   * *forecast* to cross it, because a forecast breach is the one that arrives while there
   * is still time to act.
   *
   * Budget alerts are evaluated a few times a day, not in real time. They are a safety net,
   * not a circuit breaker — the things that actually cap spend are Lambda reserved
   * concurrency, API Gateway throttling and S3 lifecycle rules.
   */
  private addBudgets(alertEmail: string): void {
    const subscribers = [{ subscriptionType: 'EMAIL', address: alertEmail }];

    for (const [id, name, amount] of [
      ['BudgetWarn', 'od-monthly-warn', BUDGET_USD.warn],
      ['BudgetStop', 'od-monthly-stop', BUDGET_USD.stop],
    ] as const) {
      new budgets.CfnBudget(this, id, {
        budget: {
          budgetName: name,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              notificationType: 'ACTUAL',
              comparisonOperator: 'GREATER_THAN',
              threshold: 100,
              thresholdType: 'PERCENTAGE',
            },
            subscribers,
          },
          {
            notification: {
              notificationType: 'FORECASTED',
              comparisonOperator: 'GREATER_THAN',
              threshold: 100,
              thresholdType: 'PERCENTAGE',
            },
            subscribers,
          },
        ],
      });
    }
  }

  /**
   * Cost Anomaly Detection over all AWS services, alerting on anomalies whose absolute
   * impact reaches the threshold.
   *
   * Frequency is `DAILY`, not `IMMEDIATE`. CloudFormation only permits `IMMEDIATE` with an
   * SNS subscriber; email subscriptions must be `DAILY` or `WEEKLY`. The per-stage
   * `od-alerts-{stage}` topic belongs to `ObservabilityStack`, and this stack is
   * account-scoped, so it must not depend on one. P0-03's console monitor — the live guard
   * until Phase 4 — is configured for individual alerts and is unaffected.
   */
  private addAnomalyDetection(alertEmail: string): void {
    const monitor = new ce.CfnAnomalyMonitor(this, 'AnomalyMonitor', {
      monitorName: 'od-all-services',
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });

    new ce.CfnAnomalySubscription(this, 'AnomalySubscription', {
      subscriptionName: 'od-anomaly-email',
      frequency: 'DAILY',
      monitorArnList: [monitor.attrMonitorArn],
      subscribers: [{ type: 'EMAIL', address: alertEmail }],
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          Values: [String(ANOMALY_THRESHOLD_USD)],
        },
      }),
    });
  }

  /**
   * The GitHub OIDC provider and one deploy role per stage (`infrastructure.md` §3.8).
   *
   * **The `sub` condition is the whole control.** A trust policy carrying only the `aud`
   * condition lets *any* GitHub repository in the world assume the role. Both conditions
   * are written here, while the role is a synthesised template and getting it wrong costs
   * nothing.
   *
   * dev trusts a branch; prod trusts the `production` **GitHub environment**, not a branch.
   * Combined with a required reviewer on that environment, the approval is what mints the
   * credential — whereas a branch-scoped prod role can be triggered by anything that can
   * push to that branch.
   */
  private addGithubDeployRoles(githubRepo: string): void {
    /**
     * `CfnOIDCProvider`, the native CloudFormation resource, not the `OpenIdConnectProvider`
     * L2 that §3.8 shows. The L2 predates CloudFormation support and still provisions a
     * `Custom::AWSCDKOpenIdConnectProvider` backed by its own Lambda and IAM role — three
     * extra resources, including a standing function holding
     * `iam:CreateOpenIDConnectProvider`, to create one provider. `thumbprintList` is
     * omitted deliberately: AWS manages thumbprints for well-known IdPs including GitHub,
     * and a hard-coded thumbprint is a time bomb that breaks deploys when it rotates.
     */
    const provider = new iam.CfnOIDCProvider(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIdList: ['sts.amazonaws.com'],
    });

    const devRole = new iam.Role(this, 'GithubDeployDev', {
      roleName: 'od-github-deploy-dev',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.attrArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:ref:refs/heads/main`,
        },
      }),
    });

    const prodRole = new iam.Role(this, 'GithubDeployProd', {
      roleName: 'od-github-deploy-prod',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.attrArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // Environment subjects are exact, so StringEquals, not StringLike.
          'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:environment:production`,
        },
      }),
    });

    // Each role may only assume the CDK bootstrap roles, and may only read CloudFormation
    // for its own stage's stacks. Neither role is given a permission on the resources
    // themselves — the deploy happens through the bootstrap roles.
    for (const [role, stage] of [
      [devRole, 'dev'],
      [prodRole, 'prod'],
    ] as const) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [
            `arn:aws:iam::${this.account}:role/cdk-odays-deploy-role-${this.account}-${this.region}`,
            `arn:aws:iam::${this.account}:role/cdk-odays-file-publishing-role-${this.account}-${this.region}`,
            `arn:aws:iam::${this.account}:role/cdk-odays-lookup-role-${this.account}-${this.region}`,
          ],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'cloudformation:DescribeStacks',
            'cloudformation:DescribeStackEvents',
          ],
          resources: [
            `arn:aws:cloudformation:${this.region}:${this.account}:stack/od-*-${stage}/*`,
          ],
        }),
      );
    }
  }
}
