import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../lib/app.js';
import { getConfig } from '../lib/config.js';

/**
 * The invariants that must hold for **every stack in the app**, swept across the real one.
 *
 * The per-stack files assert what each stack is for. This file asserts what none of them
 * may become, and it does so by walking `buildApp()` rather than a list of its own — so a
 * stack added in Phase 4 or Phase 5 inherits every assertion here on the day it is written,
 * without anyone remembering to opt it in. That is the difference between a cross-cutting
 * rule and a rule that happens to be checked in seven places today.
 *
 * Named properties, never whole-template snapshots (P0-26). A snapshot over fifteen
 * templates would be regenerated thoughtlessly the first time one of them legitimately
 * changed, and would then assert nothing at all.
 */

/**
 * Built with a web-export path that cannot exist, so the swept resource set is the same on
 * a laptop as in CI. `WebStack` adds a `BucketDeployment` — and the Lambda, role and policy
 * CDK generates alongside it — only when `apps/mobile/dist` is present, so leaving the real
 * path in would mean this file asserted over a different app depending on whether anyone
 * had run `expo export`. The built case gets its own describe at the foot of the file.
 */
const app = buildApp({ webSourcePath: 'apps/mobile/dist-absent-in-tests' });

const stacks = app.node.children.filter((child): child is cdk.Stack =>
  cdk.Stack.isStack(child),
);

interface Resource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

const templates: Array<{ name: string; resources: Record<string, Resource> }> =
  stacks.map((stack) => ({
    name: stack.stackName,
    resources: (Template.fromStack(stack).toJSON().Resources ?? {}) as Record<
      string,
      Resource
    >,
  }));

/** Every resource in the app, tagged with the stack it came from. */
const allResources = templates.flatMap(({ name, resources }) =>
  Object.entries(resources).map(([logicalId, resource]) => ({
    name,
    logicalId,
    resource,
  })),
);

const resourcesOfType = (type: string) =>
  allResources.filter(({ resource }) => resource.Type === type);

/**
 * Every "no resource of this kind violates X" assertion below passes trivially when there
 * are no resources of that kind. These counts are asserted first, so the sweep cannot
 * quietly become a set of tautologies the day a refactor moves something — the failure mode
 * where a green suite proves nothing at all.
 */
describe('the sweep has something to sweep', () => {
  const expected: Array<[string, number]> = [
    // Two stages: one API access log group and one Lambda log group each.
    ['AWS::Logs::LogGroup', 4],
    ['AWS::CloudWatch::Alarm', 12],
    // The media and web buckets, per stage.
    ['AWS::S3::Bucket', 4],
    ['AWS::DynamoDB::Table', 2],
    // Two deploy roles, plus the API Lambda's execution role per stage.
    ['AWS::IAM::Role', 4],
  ];

  it.each(expected)('%s appears at least %i times', (type, atLeast) => {
    expect(resourcesOfType(type).length).toBeGreaterThanOrEqual(atLeast);
  });
});

describe('the app', () => {
  it('builds the eight stacks the architecture describes, across both stages', () => {
    expect(templates.map((t) => t.name).sort()).toEqual([
      'od-account',
      'od-api-dev',
      'od-api-prod',
      'od-auth-dev',
      'od-auth-prod',
      'od-data-dev',
      'od-data-prod',
      'od-dns-dev',
      'od-dns-prod',
      'od-observability-dev',
      'od-observability-prod',
      'od-scheduler-dev',
      'od-scheduler-prod',
      'od-web-dev',
      'od-web-prod',
    ]);
  });

  /**
   * P0-09's rule, and the reason `cdk synth` is green in CI with no AWS role. A stack with
   * a concrete environment synthesises only where credentials resolve one, which turns a
   * CI job into something that passes on the founder's laptop and nowhere else.
   */
  it.each(stacks.map((s) => [s.stackName, s] as const))(
    '%s synthesises with no environment configured',
    (_name, stack) => {
      expect(cdk.Token.isUnresolved(stack.account)).toBe(true);
      expect(cdk.Token.isUnresolved(stack.region)).toBe(true);
    },
  );
});

/**
 * The cost rule with the sharpest edge. A NAT gateway is roughly $32/month before a byte
 * moves through it, which is more than this entire product is budgeted for, and it arrives
 * silently — attached to the first VPC anybody adds for a database or a private subnet.
 * `CLAUDE.md` rejects hourly charges by default; this is that rule as a test.
 */
describe('nothing in the app costs money by the hour', () => {
  it.each([
    'AWS::EC2::NatGateway',
    'AWS::EC2::VPC',
    'AWS::EC2::Subnet',
    'AWS::ElasticLoadBalancingV2::LoadBalancer',
    'AWS::RDS::DBInstance',
    'AWS::ECS::Service',
    'AWS::OpenSearchService::Domain',
  ])('emits no %s in any stack', (type) => {
    expect(resourcesOfType(type).map((r) => `${r.name}/${r.logicalId}`)).toEqual([]);
  });
});

/**
 * The local-first shape (P0-26). No stage sets `cfg.domain` until Phase 5, so the whole app
 * must synthesise without a certificate, a DNS record or an API domain name anywhere —
 * these are the resources that would need a hosted zone that does not exist.
 */
describe('while no domain is registered', () => {
  it.each([
    'AWS::CertificateManager::Certificate',
    'AWS::Route53::RecordSet',
    'AWS::Route53::HostedZone',
    'AWS::ApiGatewayV2::DomainName',
    'AWS::ApiGatewayV2::ApiMapping',
  ])('emits no %s in any stack', (type) => {
    expect(resourcesOfType(type).map((r) => `${r.name}/${r.logicalId}`)).toEqual([]);
  });
});

describe('every log group', () => {
  /**
   * Retention must be **the value that stage's config names** — 14 days in dev, 30 in prod
   * — not merely present.
   *
   * "Present" is almost worthless as an assertion, and this was written that way first: a
   * probe that added a bare `new LogGroup(this, 'NoRetention', {})` sailed through it,
   * because CDK's L2 quietly defaults to `TWO_YEARS`. That default is precisely the failure
   * the rule exists to stop — CloudWatch storage is billed per GB per month, nothing fails,
   * nothing alarms, and the bill grows in a line item nobody reads. Pinning the value
   * catches the forgotten group and the defaulted one alike.
   */
  it('retains for exactly as long as its stage’s config says', () => {
    const expectedFor = (stackName: string) =>
      stackName.endsWith('-prod') ? getConfig('prod') : getConfig('dev');

    const wrong = resourcesOfType('AWS::Logs::LogGroup')
      .filter(
        ({ name, resource }) =>
          resource.Properties?.RetentionInDays !== expectedFor(name).logRetentionDays,
      )
      .map(
        (r) =>
          `${r.name}/${r.logicalId} kept ${String(r.resource.Properties?.RetentionInDays)}`,
      );

    expect(wrong).toEqual([]);
  });

  it('is created by the stack rather than by a log-retention custom resource', () => {
    // `Custom::LogRetention` is what CDK emits when a construct sets `logRetention`
    // instead of declaring a log group. It provisions a Lambda to call an API that a
    // `LogGroup` sets declaratively, and it is billable and undeletable.
    expect(resourcesOfType('Custom::LogRetention')).toEqual([]);
  });
});

describe('every bucket', () => {
  it('blocks public access on all four settings', () => {
    const notBlocked = resourcesOfType('AWS::S3::Bucket')
      .filter(({ resource }) => {
        const block = resource.Properties?.PublicAccessBlockConfiguration as
          | Record<string, unknown>
          | undefined;
        return (
          block?.BlockPublicAcls !== true ||
          block?.BlockPublicPolicy !== true ||
          block?.IgnorePublicAcls !== true ||
          block?.RestrictPublicBuckets !== true
        );
      })
      .map((r) => `${r.name}/${r.logicalId}`);

    expect(notBlocked).toEqual([]);
  });
});

describe('every alarm', () => {
  /**
   * An alarm with no action is a dashboard decoration. It goes red and nobody is told,
   * which is worse than not having it — it looks like monitoring.
   */
  it('notifies something when it fires', () => {
    const silent = resourcesOfType('AWS::CloudWatch::Alarm')
      .filter(({ resource }) => {
        const actions = resource.Properties?.AlarmActions;
        return !Array.isArray(actions) || actions.length === 0;
      })
      .map((r) => `${r.name}/${r.logicalId}`);

    expect(silent).toEqual([]);
  });
});

/**
 * `RemovalPolicy.RETAIN` on prod stateful resources. The failure this prevents is the
 * expensive kind and the irreversible kind at once: a stack rename, a logical-id change or
 * a `cdk destroy` aimed at the wrong stage takes the table with it.
 */
describe('prod stateful resources', () => {
  const STATEFUL = ['AWS::DynamoDB::Table', 'AWS::S3::Bucket'];

  it('are retained on delete and on replace', () => {
    const prodStateful = allResources.filter(
      ({ name, resource }) => name.endsWith('-prod') && STATEFUL.includes(resource.Type),
    );

    // The table and both prod buckets, at minimum. Without this the filter below asserts
    // nothing the moment a rename stops `-prod` matching.
    expect(prodStateful.length).toBeGreaterThanOrEqual(3);

    const unprotected = prodStateful
      .filter(
        ({ resource }) =>
          resource.DeletionPolicy !== 'Retain' ||
          resource.UpdateReplacePolicy !== 'Retain',
      )
      .map((r) => `${r.name}/${r.logicalId}`);

    expect(unprotected).toEqual([]);
  });

  it('leaves dev disposable, so the rule is a decision rather than a default', () => {
    const devStateful = allResources.filter(
      ({ name, resource }) => name.endsWith('-dev') && STATEFUL.includes(resource.Type),
    );

    expect(devStateful.length).toBeGreaterThan(0);
    for (const { resource } of devStateful) {
      expect(resource.DeletionPolicy).toBe('Delete');
    }
  });
});

/**
 * No `*` on `*`, anywhere. Each stack's own file asserts this for the roles it creates;
 * sweeping it means a policy added to a stack that has no test yet is still caught.
 */
/**
 * The other half of the web deployment, asserted separately because it only exists once
 * `expo export` has run — which is the state Phase 4's CI is in when it deploys. The
 * `BucketDeployment` brings a CDK-generated Lambda, role and policy with it, and those have
 * to satisfy the same invariants as anything the stacks write by hand.
 */
describe('with the web export built', () => {
  const built = buildApp({ webSourcePath: 'infra/test/fixtures' });
  const webStack = built.node.children.find(
    (child): child is cdk.Stack =>
      cdk.Stack.isStack(child) && child.stackName === 'od-web-prod',
  );
  const template = Template.fromStack(webStack as cdk.Stack);

  it('adds the deployment', () => {
    template.resourceCountIs('Custom::CDKBucketDeployment', 1);
  });

  it('brings no log-retention custom resource with it', () => {
    template.resourceCountIs('Custom::LogRetention', 0);
  });

  it('keeps the bucket private even with an uploader attached', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

/**
 * Mechanism 3 of P1-02's three, and the reason it lives in the sweep rather than beside the
 * API's own assertions: it must hold for **every function in the app**, including ones no
 * Phase 1 task has written. A scheduler Lambda in Phase 2 or an SES handler in Phase 6
 * inherits this on the day it is created, without anyone remembering to opt it in.
 *
 * `AUTH_MODE=local` runs `LocalIdentityProvider`, which answers as the constant
 * `usr_local_dev` for every caller. On a deployed function that is one shared account
 * holding everybody's data, failing silently. The runtime guard in
 * `services/api/src/lib/config.ts` catches it during init; this catches it in CI, before
 * a template that carries it can ever be deployed.
 */
describe('no deployed function can run the local identity provider', () => {
  const functions = resourcesOfType('AWS::Lambda::Function');

  it('has functions to sweep', () => {
    expect(functions.length).toBeGreaterThanOrEqual(2);
  });

  it('sets AUTH_MODE to local nowhere in the app', () => {
    const offenders = functions
      .filter(({ resource }) => {
        const env = (
          resource.Properties as
            | { Environment?: { Variables?: Record<string, unknown> } }
            | undefined
        )?.Environment?.Variables;
        return env?.AUTH_MODE === 'local';
      })
      .map(({ name, logicalId }) => `${name}/${logicalId}`);

    expect(offenders).toEqual([]);
  });

  /**
   * The API function is the only one that resolves an identity today, so it is the only one
   * that must *state* a mode — asserted here as well as in `api-stack.test.ts` because that
   * file proves the stack sets it and this one proves the swept app still contains it.
   */
  it('states cognito on every function that sets AUTH_MODE at all', () => {
    const modes = functions
      .map(
        ({ resource }) =>
          (
            resource.Properties as
              | { Environment?: { Variables?: Record<string, unknown> } }
              | undefined
          )?.Environment?.Variables?.AUTH_MODE,
      )
      .filter((mode): mode is string => mode !== undefined);

    expect(modes.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(modes)]).toEqual(['cognito']);
  });
});

describe('no IAM policy grants everything on everything', () => {
  it('has no statement with both Action * and Resource *', () => {
    const offenders: string[] = [];

    for (const { name, logicalId, resource } of allResources) {
      if (resource.Type !== 'AWS::IAM::Policy' && resource.Type !== 'AWS::IAM::Role') {
        continue;
      }
      const json = JSON.stringify(resource.Properties ?? {});
      if (json.includes('"Action":"*"') && json.includes('"Resource":"*"')) {
        offenders.push(`${name}/${logicalId}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
