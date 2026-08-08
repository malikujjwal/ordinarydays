import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { applyStackTags } from '../tags.js';
import type { DnsStack } from './dns-stack.js';

/**
 * `od-auth-{stage}` — Cognito (`infrastructure.md` §1.1).
 *
 * A shell, and P0-18 leaves it one. It gains the user pool, the three app clients
 * (`auth.md` §1.7), the user pool domain and the pre-sign-up and post-confirmation Lambdas
 * in **P4-08**, and the Apple identity provider in **P4-10** — Phase 4, which is when
 * identity stops being deferred. It is the one shell of the three that Phase 4 deploys.
 *
 * Nothing is exported from it yet, deliberately. `ApiStack` already takes it as a prop and
 * reads nothing off it; the user pool id and client ids appear here when P4-08 creates the
 * things they identify. A field declared before its resource exists reads as an implemented
 * control that is not one — the same argument that kept `AUTH_MODE` out of `ApiStack` in
 * P0-15.
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
