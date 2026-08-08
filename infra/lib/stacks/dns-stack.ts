import * as cdk from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { applyStackTags } from '../tags.js';

/**
 * `od-dns-{stage}` — Route 53 and ACM only (`infrastructure.md` §1.1).
 *
 * Named `DnsStack`, not `NetworkStack`, deliberately: there is no VPC, subnet, security
 * group or network in this architecture, and a stack called `NetworkStack` invites someone
 * to add one.
 *
 * Stays an empty shell through **P0-18**. It gains the hosted zone, the edge certificate
 * for `*.{domain}` and the API certificate in **Phase 5**, when the domain is first
 * registered. Until then no stage sets `cfg.domain`, so there is nothing to certify.
 *
 * When it is filled: no `HostedZone.fromLookup`. A context lookup needs credentials at
 * synth time and turns a green CI job into one that passes only on the founder's laptop.
 */
export interface DnsStackProps extends cdk.StackProps {
  cfg: EnvConfig;
}

export class DnsStack extends cdk.Stack {
  /**
   * The ACM certificate for the API's custom domain, in the API's own region.
   *
   * `undefined` until Phase 5 registers the domain and fills this stack. It is declared now
   * so that `ApiStack` can gate its custom-domain branch on the **construct** rather than on
   * an ARN string: passing an ARN produces a race on first deploy, because CloudFormation
   * has no dependency edge to order the certificate before the domain mapping
   * (`infrastructure.md` §1.2, P0-15). Typing it here makes that rule structural instead of
   * a comment a future task has to remember.
   */
  readonly apiCertificate?: acm.ICertificate;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'dns', props.cfg.stage);
  }
}
