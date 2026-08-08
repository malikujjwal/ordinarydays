import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { applyStackTags } from '../tags.js';

/**
 * `od-account` — account-scoped, environment-independent (`infrastructure.md` §1.1,
 * adjustment 2). Deployed **once**, not per stage: an IAM OIDC provider for
 * `token.actions.githubusercontent.com` can exist only once per account, and budgets track
 * total account spend. Duplicating either per stage is a deploy conflict on the second one.
 *
 * Resources are added by **P0-11**: the $5 and $20 monthly budgets with email
 * notifications, the Cost Anomaly Detection monitor, and the GitHub OIDC provider plus the
 * `od-github-deploy-{stage}` roles (`infrastructure.md` §3.4, §3.8).
 *
 * Written and synthesised only in Phase 0 — it is not deployed. The console budget from
 * P0-03 is the live guard until Phase 4.
 */
export interface AccountStackProps extends cdk.StackProps {}

export class AccountStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AccountStackProps = {}) {
    super(scope, id, props);
    applyStackTags(this, 'account');
  }
}
