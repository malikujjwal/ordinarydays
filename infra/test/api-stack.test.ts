import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { getConfig } from '../lib/config.js';
import { ApiStack } from '../lib/stacks/api-stack.js';
import { AuthStack } from '../lib/stacks/auth-stack.js';
import { DataStack } from '../lib/stacks/data-stack.js';
import { DnsStack } from '../lib/stacks/dns-stack.js';

/**
 * Synthesised once per stage and reused: each `ApiStack` runs esbuild over the real API
 * source, so building one is seconds rather than milliseconds.
 */
function build(stage: 'dev' | 'prod') {
  const app = new cdk.App();
  const cfg = getConfig(stage);
  const dns = new DnsStack(app, `od-dns-${stage}`, { cfg });
  const auth = new AuthStack(app, `od-auth-${stage}`, { cfg, dns });
  const data = new DataStack(app, `od-data-${stage}`, { cfg });
  const api = new ApiStack(app, `od-api-${stage}`, { cfg, dns, auth, data });
  return Template.fromStack(api);
}

const dev = build('dev');
const prod = build('prod');

describe('the API Lambda', () => {
  it('keeps the NodeLambda guarantees', () => {
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      MemorySize: 1024,
      Timeout: 15,
    });
  });

  it('takes reserved concurrency from cfg', () => {
    dev.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 20,
    });
    prod.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 50,
    });
  });

  /**
   * These keys are what `services/api/src/lib/config.ts` parses with Zod at module load,
   * and it throws on a missing one. A name that drifts is therefore a cold-start crash on
   * every invocation — which synth cannot see and no CDK assertion would otherwise catch.
   *
   * `infra` may not import `services/api` (`repo-structure.md` §3), so this is an exact-set
   * assertion rather than a shared constant. `STAGE` comes from `NodeLambda`; `AUTH_MODE`
   * is set here as a literal (P1-02).
   */
  it('passes exactly the environment the API parses', () => {
    const fn = Object.values(prod.findResources('AWS::Lambda::Function'))[0] as {
      Properties: { Environment: { Variables: Record<string, unknown> } };
    };
    expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual([
      'AUTH_MODE',
      'GIT_SHA',
      'LOG_LEVEL',
      'MEDIA_BUCKET',
      'STAGE',
      'TABLE_NAME',
      'WEB_ORIGINS',
    ]);
  });

  /**
   * Mechanism 2 of P1-02's three, asserted per stage.
   *
   * The value is a literal in `api-stack.ts` with no input that can change it. This asserts
   * the *value*, not merely the key's presence: a stack that read the mode from `cfg` or
   * from `process.env` would still pass the exact-set assertion above while being exactly
   * the thing the guard exists to prevent.
   */
  it.each([
    ['dev', dev],
    ['prod', prod],
  ] as const)('runs the %s API in cognito mode, never local', (_stage, template) => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { AUTH_MODE: 'cognito' } },
    });
  });

  it('holds no secret in its environment', () => {
    const vars = JSON.stringify(
      (
        Object.values(prod.findResources('AWS::Lambda::Function'))[0] as {
          Properties: { Environment: unknown };
        }
      ).Properties.Environment,
    ).toLowerCase();
    for (const smell of ['password', 'secret', 'apikey', 'token', 'akia']) {
      expect(vars).not.toContain(smell);
    }
  });
});

describe('the live alias', () => {
  it('publishes a version behind an alias named live', () => {
    prod.resourceCountIs('AWS::Lambda::Version', 1);
    prod.hasResourceProperties('AWS::Lambda::Alias', { Name: 'live' });
  });

  /**
   * The assertion most likely to be silently wrong, and the one that decides whether a bad
   * deploy can be reverted in seconds. If the integration points at the function instead of
   * the alias, `aws lambda update-alias` changes nothing and the only way back is a
   * redeploy (`infrastructure.md` §4.4).
   */
  it('is what the integration targets, not $LATEST', () => {
    const integration = Object.values(
      prod.findResources('AWS::ApiGatewayV2::Integration'),
    )[0] as { Properties: { IntegrationUri: unknown } };
    const aliasLogicalId = Object.keys(prod.findResources('AWS::Lambda::Alias'))[0];

    expect(integration.Properties.IntegrationUri).toEqual({ Ref: aliasLogicalId });
  });
});

describe('the HTTP API', () => {
  it('declares exactly one route, $default — all routing is in Hono', () => {
    prod.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
    prod.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });
  });

  it('uses payload format 2.0, which the Hono adapter is built around', () => {
    prod.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      PayloadFormatVersion: '2.0',
      IntegrationType: 'AWS_PROXY',
    });
  });

  it('throttles at burst 100 / rate 50', () => {
    prod.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingBurstLimit: 100, ThrottlingRateLimit: 50 },
    });
  });

  it('writes JSON access logs', () => {
    prod.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AccessLogSettings: Match.objectLike({
        Format: Match.stringLikeRegexp('requestId'),
      }),
    });
  });

  // No authorizer, by design: auth happens in the Lambda so the public invite routes and
  // the authenticated routes share one code path and one error envelope.
  it('has no API Gateway authorizer', () => {
    prod.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 0);
  });

  // No stage sets cfg.apiDomain until Phase 5. That single branch at construction is what
  // lets this stack synthesise before a domain exists.
  it('emits no custom domain while apiDomain is unset', () => {
    expect(getConfig('prod').apiDomain).toBeUndefined();
    prod.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
    prod.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 0);
  });
});

describe('log groups', () => {
  it('retain per cfg — 14 days in dev, 30 in prod', () => {
    const retentions = (t: Template) =>
      Object.values(t.findResources('AWS::Logs::LogGroup'))
        .map(
          (g) =>
            (g as { Properties: { RetentionInDays: number } }).Properties.RetentionInDays,
        )
        .sort();
    expect(retentions(dev)).toEqual([14, 14]);
    expect(retentions(prod)).toEqual([30, 30]);
  });
});

describe('the execution role', () => {
  it('grants no statement of * on *', () => {
    for (const policy of Object.values(prod.findResources('AWS::IAM::Policy'))) {
      const doc = (
        policy as {
          Properties: {
            PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> };
          };
        }
      ).Properties.PolicyDocument;
      for (const s of doc.Statement) {
        expect([s.Action].flat()).not.toContain('*');
        expect([s.Resource].flat()).not.toContain('*');
      }
    }
  });

  /**
   * S3 is scoped to the two prefixes the product writes — `u/…` for confirmed media and
   * `tmp/` for an upload not yet linked to an activity. A bucket-wide grant would also
   * cover anything a future task puts in that bucket.
   */
  it('reaches only the u/ and tmp/ prefixes in S3', () => {
    const policies = JSON.stringify(prod.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('u/*');
    expect(policies).toContain('tmp/*');
    expect(policies).toContain('s3:DeleteObject');

    const s3Statements = Object.values(prod.findResources('AWS::IAM::Policy')).flatMap(
      (p) =>
        (
          p as {
            Properties: {
              PolicyDocument: {
                Statement: Array<{ Action: unknown; Resource: unknown }>;
              };
            };
          }
        ).Properties.PolicyDocument.Statement.filter((s) =>
          JSON.stringify(s.Action).includes('s3:'),
        ),
    );
    expect(s3Statements.length).toBeGreaterThan(0);
    for (const s of s3Statements) {
      // Every S3 resource must be a prefixed object ARN, never the bare bucket.
      expect(JSON.stringify(s.Resource)).toMatch(/u\/\*|tmp\/\*/);
    }
  });

  it('can read and write the table', () => {
    const policies = JSON.stringify(prod.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('dynamodb:GetItem');
    expect(policies).toContain('dynamodb:PutItem');
    expect(policies).toContain('dynamodb:Query');
  });
});

describe('cost shape', () => {
  /**
   * `cost-model.md` prices this stack from its inventory: Lambda §2.3 always free,
   * API Gateway §2.2 free for 12 months then $1.00/M, CloudWatch Logs §2.12 always free,
   * IAM free. An unexpected resource changes that answer, so the inventory is pinned.
   */
  it('is exactly the resources cost-model.md prices', () => {
    const counts: Record<string, number> = {};
    for (const r of Object.values(
      prod.toJSON().Resources as Record<string, { Type: string }>,
    )) {
      if (r.Type === 'AWS::CDK::Metadata') continue;
      counts[r.Type] = (counts[r.Type] ?? 0) + 1;
    }
    expect(counts).toEqual({
      'AWS::ApiGatewayV2::Api': 1,
      'AWS::ApiGatewayV2::Integration': 1,
      'AWS::ApiGatewayV2::Route': 1,
      'AWS::ApiGatewayV2::Stage': 1,
      'AWS::IAM::Policy': 1,
      'AWS::IAM::Role': 1,
      'AWS::Lambda::Alias': 1,
      'AWS::Lambda::Function': 1,
      'AWS::Lambda::Permission': 1,
      'AWS::Lambda::Version': 1,
      'AWS::Logs::LogGroup': 2,
    });
  });
});
