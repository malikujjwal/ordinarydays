import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { applyStackTags } from '../tags.js';
import type { AuthStack } from './auth-stack.js';
import type { DataStack } from './data-stack.js';
import type { DnsStack } from './dns-stack.js';

/**
 * `od-api-{stage}` — the single Lambda and the HTTP API in front of it
 * (`infrastructure.md` §1.1).
 *
 * Resources are added by **P0-15**: a `NodeLambda` for `od-api-{stage}` entered at
 * `services/api/src/index.ts`, the HTTP API with one `$default` route and payload format
 * 2.0, throttling at burst 100 / rate 50 rps, and an access log group. It publishes a
 * version and points the integration at the `live` **alias**, never `$LATEST`, so a bad
 * deploy can be reverted by moving the alias (§4.4).
 *
 * The custom domain, its certificate and its alias record are added **only when
 * `cfg.apiDomain` is set**, which no stage does until Phase 5. That single branch at
 * construction is what lets this stack synthesise before a domain exists.
 */
export interface ApiStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  dns: DnsStack;
  auth: AuthStack;
  data: DataStack;
}

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'api', props.cfg.stage);
  }
}
