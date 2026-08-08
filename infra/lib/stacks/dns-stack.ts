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
 * A shell, and P0-18 leaves it one. It gains the zone reference, the edge certificate for
 * `*.{domain}` and the API certificate in **P5-01**, when the domain is first registered —
 * registering it in Route 53 is what creates the public hosted zone, so this stack refers to
 * a zone rather than declaring one. Until then no stage sets `cfg.domain`, so there is
 * nothing to certify, and it is not in Phase 4's dev deploy set (**P4-05**).
 *
 * > **Corrected in P0-18: the `HostedZone.fromLookup` ban is a Phase 0 rule, not a
 * > permanent one.** This said "when it is filled: no `HostedZone.fromLookup`", which reads
 * > as a prohibition on the very thing P5-01 instructs — it looks the zone up, because by
 * > then the zone exists and CI has a deploy role. The real rule, from P0-09, is that **no
 * > context lookup may exist while CI synthesises without credentials**, which is exactly
 * > the period this stack spends as a shell. A lookup added here today turns a green CI job
 * > into one that passes only on the founder's laptop; the same lookup added in P5-01 comes
 * > with a checked-in `cdk.context.json` and a note about clearing it when it goes stale.
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

  /**
   * The edge certificate for `*.{domain}`, used by both CloudFront distributions.
   *
   * CloudFront requires its certificate in **`us-east-1`** regardless of where the
   * distribution's other resources live, which is one of the reasons this stack owns it
   * rather than each consumer minting its own. `undefined` until Phase 5, for the same
   * reason as `apiCertificate`, and passed as a construct for the same ordering reason.
   */
  readonly edgeCertificate?: acm.ICertificate;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'dns', props.cfg.stage);
  }
}
