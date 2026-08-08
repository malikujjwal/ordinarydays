import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { applyStackTags } from '../tags.js';
import type { DnsStack } from './dns-stack.js';

/**
 * `od-auth-{stage}` — Cognito (`infrastructure.md` §1.1).
 *
 * Stays an empty shell through **P0-18**. It gains the user pool, the three app clients
 * (`auth.md` §1.7), the user pool domain, the Apple identity provider, and the pre-sign-up
 * and post-confirmation Lambdas in **Phase 4**, which is when identity stops being deferred.
 *
 * Takes `dns` because the Cognito custom domain needs the zone once one exists. The
 * construct is passed, never an `Fn::ImportValue` string (§1.2).
 */
export interface AuthStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  dns: DnsStack;
}

export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'auth', props.cfg.stage);
  }
}
