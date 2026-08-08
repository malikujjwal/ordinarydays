import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { applyStackTags } from '../tags.js';

/**
 * `od-data-{stage}` — the stateful stack: the DynamoDB table and the media bucket
 * (`infrastructure.md` §1.1).
 *
 * Purely stateful by design. The media **CloudFront distribution** lives in `WebStack`, not
 * here, so that every distribution and cache policy is in one file and this stack never
 * needs touching for a front-end change (§1.1, adjustment 1).
 *
 * Resources are added by **P0-12**: table `od-main-{stage}`, `PAY_PER_REQUEST`, one GSI
 * with projection `INCLUDE`, TTL on `ttl`, and the media bucket. Every key attribute, index
 * name and projected attribute is read from `@od/shared/table`, which is the single
 * definition three consumers share (`repo-structure.md` §3).
 *
 * In prod its resources carry `RemovalPolicy.RETAIN` and deletion protection, so a
 * `cdk destroy` of the app cannot take the table with it.
 */
export interface DataStackProps extends cdk.StackProps {
  cfg: EnvConfig;
}

export class DataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'data', props.cfg.stage);
  }
}
