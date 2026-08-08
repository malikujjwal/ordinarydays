import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { applyStackTags } from '../tags.js';
import type { DataStack } from './data-stack.js';
import type { DnsStack } from './dns-stack.js';

/**
 * `od-web-{stage}` — every CloudFront distribution in the product
 * (`infrastructure.md` §1.1).
 *
 * Resources are added by **P0-16**: a private S3 bucket with Origin Access Control (not
 * OAI), the two cache policies, the response-headers policy, the viewer-request function
 * that rewrites extensionless paths for Expo Router's static export — **and the media
 * distribution** over `DataStack`'s bucket, which lives here rather than in `DataStack` so
 * that every distribution and cache policy is in one file (§1.1, adjustment 1).
 *
 * The edge certificate and alternate domain name are added only when `cfg.domain` is set;
 * until Phase 5 the distribution is reachable on its `*.cloudfront.net` name.
 *
 * P0-16 must guard the `BucketDeployment`: it fails at synth if `apps/mobile/dist` does not
 * exist, which in Phase 0 it usually does not.
 */
export interface WebStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  dns: DnsStack;
  data: DataStack;
}

export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'web', props.cfg.stage);
  }
}
