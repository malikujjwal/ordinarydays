import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { getConfig } from '../lib/config.js';
import { contentSecurityPolicy } from '../lib/constructs/static-site.js';
import { DataStack } from '../lib/stacks/data-stack.js';
import { DnsStack } from '../lib/stacks/dns-stack.js';
import { WebStack } from '../lib/stacks/web-stack.js';

function build(stage: 'dev' | 'prod') {
  const app = new cdk.App();
  const cfg = getConfig(stage);
  const dns = new DnsStack(app, `od-dns-${stage}`, { cfg });
  const data = new DataStack(app, `od-data-${stage}`, { cfg });
  const web = new WebStack(app, `od-web-${stage}`, { cfg, dns, data });
  return { web: Template.fromStack(web), data: Template.fromStack(data) };
}

const prod = build('prod');

type Dist = {
  Properties: {
    DistributionConfig: {
      Comment: string;
      PriceClass: string;
      HttpVersion: string;
      DefaultRootObject?: string;
      Aliases?: string[];
      ViewerCertificate?: Record<string, unknown>;
      Origins: Array<{ OriginAccessControlId?: unknown; S3OriginConfig?: unknown }>;
      DefaultCacheBehavior: {
        ViewerProtocolPolicy: string;
        FunctionAssociations?: Array<{ EventType: string }>;
      };
      CacheBehaviors?: Array<{ PathPattern: string }>;
    };
  };
};

const distributions = () =>
  Object.values(prod.web.findResources('AWS::CloudFront::Distribution')) as Dist[];

const byComment = (comment: string) =>
  distributions().find((d) => d.Properties.DistributionConfig.Comment === comment);

describe('both distributions', () => {
  it('exist — every CloudFront distribution in the product lives in this stack', () => {
    prod.web.resourceCountIs('AWS::CloudFront::Distribution', 2);
    expect(
      distributions()
        .map((d) => d.Properties.DistributionConfig.Comment)
        .sort(),
    ).toEqual(['od-media-prod', 'od-web-prod']);
  });

  it.each(['od-web-prod', 'od-media-prod'])(
    '%s is PRICE_CLASS_100 over HTTP/2+3',
    (c) => {
      const cfg = byComment(c)?.Properties.DistributionConfig;
      expect(cfg?.PriceClass).toBe('PriceClass_100');
      expect(cfg?.HttpVersion).toBe('http2and3');
      expect(cfg?.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    },
  );

  // OAC, not OAI. OAI is the legacy mechanism; an origin still using it would show an
  // S3OriginConfig with an OriginAccessIdentity instead.
  it.each(['od-web-prod', 'od-media-prod'])('%s reads S3 through OAC', (c) => {
    for (const origin of byComment(c)?.Properties.DistributionConfig.Origins ?? []) {
      expect(origin.OriginAccessControlId).toBeDefined();
    }
  });

  // No stage sets a domain until Phase 5, so both are reachable on *.cloudfront.net.
  it.each(['od-web-prod', 'od-media-prod'])('%s has no alias or ACM certificate', (c) => {
    const cfg = byComment(c)?.Properties.DistributionConfig;
    expect(cfg?.Aliases).toBeUndefined();
    expect(JSON.stringify(cfg?.ViewerCertificate ?? {})).not.toContain('acm');
    expect(JSON.stringify(cfg?.ViewerCertificate ?? {})).not.toContain(
      'AcmCertificateArn',
    );
  });
});

describe('the web distribution', () => {
  it('serves index.html at the root', () => {
    expect(
      byComment('od-web-prod')?.Properties.DistributionConfig.DefaultRootObject,
    ).toBe('index.html');
  });

  it('associates the URI-rewrite function on viewer-request', () => {
    const assoc =
      byComment('od-web-prod')?.Properties.DistributionConfig.DefaultCacheBehavior
        .FunctionAssociations ?? [];
    expect(assoc.map((a) => a.EventType)).toEqual(['viewer-request']);
    prod.web.resourceCountIs('AWS::CloudFront::Function', 1);
  });

  it('has a separate behaviour for the hashed asset path', () => {
    const behaviors =
      byComment('od-web-prod')?.Properties.DistributionConfig.CacheBehaviors ?? [];
    expect(behaviors.map((b) => b.PathPattern)).toEqual(['/_expo/static/*']);
  });

  /**
   * Two cache policies for the web distribution: hashed assets are immutable for a year,
   * everything else revalidates so a deploy is visible immediately rather than after a TTL
   * nobody remembers setting. The third belongs to the media distribution.
   */
  it('declares an immutable policy and a revalidating one', () => {
    prod.web.resourceCountIs('AWS::CloudFront::CachePolicy', 3);
    const ttls = Object.values(
      prod.web.findResources('AWS::CloudFront::CachePolicy'),
    ).map(
      (p) =>
        (p as { Properties: { CachePolicyConfig: { DefaultTTL: number } } }).Properties
          .CachePolicyConfig.DefaultTTL,
    );
    expect(ttls).toContain(0);
    expect(ttls).toContain(31536000);
  });

  it('sets a Cache-Control header per behaviour', () => {
    const headers = JSON.stringify(
      prod.web.findResources('AWS::CloudFront::ResponseHeadersPolicy'),
    );
    expect(headers).toContain('public, max-age=31536000, immutable');
    expect(headers).toContain('no-store, must-revalidate');
  });
});

describe('security headers', () => {
  it('sets HSTS, nosniff, referrer policy, frame deny and permissions policy', () => {
    prod.web.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({
            AccessControlMaxAgeSec: 63072000,
            IncludeSubdomains: true,
            Preload: true,
          }),
          ContentTypeOptions: { Override: true },
          FrameOptions: Match.objectLike({ FrameOption: 'DENY' }),
        }),
      }),
    });
    expect(
      JSON.stringify(prod.web.findResources('AWS::CloudFront::ResponseHeadersPolicy')),
    ).toContain('camera=(), microphone=(), geolocation=(), payment=()');
  });

  /**
   * Report-only, and a custom header rather than the built-in CSP field, because
   * CloudFront's response-headers policy has no report-only mode. P5-06 moves the same
   * string into the enforcing field once a real export has run in a browser.
   */
  it('ships the CSP report-only, never enforcing, in Phase 0', () => {
    const policies = JSON.stringify(
      prod.web.findResources('AWS::CloudFront::ResponseHeadersPolicy'),
    );
    expect(policies).toContain('Content-Security-Policy-Report-Only');
    expect(policies).not.toContain('"ContentSecurityPolicy"');
  });

  it('builds a CSP with no unsafe script source', () => {
    const csp = contentSecurityPolicy(getConfig('prod'));
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'unsafe-eval'");
    // Required: React Native Web injects styles at runtime. A far weaker primitive.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('omits the media and API hosts while no domain is registered', () => {
    const csp = contentSecurityPolicy(getConfig('prod'));
    expect(csp).not.toContain('ordinarydays.app');
    expect(csp).toContain('https://cognito-idp.us-east-1.amazonaws.com');
  });
});

describe('the web bucket', () => {
  it('blocks all public access and is versioned', () => {
    prod.web.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('has no public bucket policy — only CloudFront may read it', () => {
    const statements = Object.values(prod.web.findResources('AWS::S3::BucketPolicy'))
      .flatMap(
        (p) =>
          (
            p as {
              Properties: {
                PolicyDocument: {
                  Statement: Array<{ Effect: string; Principal?: unknown }>;
                };
              };
            }
          ).Properties.PolicyDocument.Statement,
      )
      .filter((s) => s.Effect === 'Allow');

    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(JSON.stringify(s.Principal)).not.toContain('"*"');
      expect(JSON.stringify(s.Principal)).toContain('cloudfront.amazonaws.com');
    }
  });

  /**
   * The web bucket and its distribution are in the same stack, so its OAC policy keeps the
   * **exact distribution ARN** condition. Only the media bucket, whose distribution is in
   * another stack, falls back to an account condition — see the next block.
   */
  it('conditions CloudFront read on this exact distribution', () => {
    const policy = JSON.stringify(prod.web.findResources('AWS::S3::BucketPolicy'));
    expect(policy).toContain('AWS:SourceArn');
    expect(policy).toContain('WebDistribution');
    expect(policy).not.toContain('distribution/*');
  });
});

describe('the media bucket grant (in DataStack)', () => {
  /**
   * The documented cycle break. OAC conditions on the distribution's ARN, the media
   * distribution is in `WebStack` and the bucket is in `DataStack`, and an ARN condition
   * would make those two stacks depend on each other. `aws:SourceAccount` closes the
   * confused-deputy case — someone else's distribution reading our bucket — and gives up
   * only the distinction between distributions inside this single-tenant account.
   */
  it('conditions on the account, with a wildcard ARN for intent', () => {
    const statement = Object.values(prod.data.findResources('AWS::S3::BucketPolicy'))
      .flatMap(
        (p) =>
          (
            p as {
              Properties: {
                PolicyDocument: {
                  Statement: Array<{
                    Sid?: string;
                    Condition?: unknown;
                    Principal?: unknown;
                  }>;
                };
              };
            }
          ).Properties.PolicyDocument.Statement,
      )
      .find((s) => s.Sid === 'AllowCloudFrontOacRead');

    expect(statement).toBeDefined();
    expect(JSON.stringify(statement?.Principal)).toContain('cloudfront.amazonaws.com');
    const condition = JSON.stringify(statement?.Condition);
    expect(condition).toContain('AWS:SourceAccount');
    expect(condition).toContain('distribution/*');
  });
});

describe('the BucketDeployment guard', () => {
  /**
   * `BucketDeployment` fails at synth when its source directory is missing, and
   * `apps/mobile/dist` is not built until P0-19. Skipping when absent is what keeps synth
   * green in CI without an Expo build first — and it must survive into Phase 4, where CI
   * does build the export before deploying.
   */
  it('emits no deployment while the web export has not been built', () => {
    prod.web.resourceCountIs('Custom::CDKBucketDeployment', 0);
  });
});

describe('cost shape', () => {
  it('is exactly the resources cost-model.md prices', () => {
    const counts: Record<string, number> = {};
    for (const r of Object.values(
      prod.web.toJSON().Resources as Record<string, { Type: string }>,
    )) {
      if (r.Type === 'AWS::CDK::Metadata') continue;
      counts[r.Type] = (counts[r.Type] ?? 0) + 1;
    }
    expect(counts).toEqual({
      'AWS::CloudFront::CachePolicy': 3,
      'AWS::CloudFront::Distribution': 2,
      'AWS::CloudFront::Function': 1,
      'AWS::CloudFront::OriginAccessControl': 2,
      'AWS::CloudFront::ResponseHeadersPolicy': 3,
      'AWS::S3::Bucket': 1,
      'AWS::S3::BucketPolicy': 1,
    });
  });
});
