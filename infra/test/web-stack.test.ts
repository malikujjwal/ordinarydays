import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { getConfig } from '../lib/config.js';
import { contentSecurityPolicy } from '../lib/constructs/static-site.js';
import { DataStack } from '../lib/stacks/data-stack.js';
import { DnsStack } from '../lib/stacks/dns-stack.js';
import { WebStack } from '../lib/stacks/web-stack.js';

/**
 * A directory that cannot exist, so every assertion below describes the **unbuilt** stack
 * whether or not somebody has run `expo export` locally.
 *
 * Before P0-19 the real path, `apps/mobile/dist`, was never built and this was true by
 * accident. Now that the export works, leaving it implicit would make the whole file pass
 * or fail on untracked local state.
 */
const NOT_BUILT = 'apps/mobile/dist-absent-in-tests';

/** A directory that always exists, for the other half of the guard. */
const BUILT = 'infra/test/fixtures';

function build(stage: 'dev' | 'prod', webSourcePath = NOT_BUILT) {
  const app = new cdk.App();
  const cfg = getConfig(stage);
  const dns = new DnsStack(app, `od-dns-${stage}`, { cfg });
  const data = new DataStack(app, `od-data-${stage}`, { cfg });
  const web = new WebStack(app, `od-web-${stage}`, { cfg, dns, data, webSourcePath });
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

/**
 * **The media distribution's own configuration** (P3-23).
 *
 * The block above asserts what the two distributions have in common — price class, HTTP
 * version, OAC, no alias. What was unasserted until P3-23 is everything specific to the
 * media path: the cache policy's TTLs, its compression flags and cache key, the methods, and
 * the response headers. `infrastructure.md` §6.1 is explicit that MinIO models none of this,
 * so these assertions are the only thing standing behind the media configuration until the
 * stacks are deployed and exercised against the real media domain in Phase 5.
 *
 * ## Why the policy is resolved through the behaviour
 *
 * Asserting "some cache policy in this template has a 365-day default TTL" would pass on the
 * **web** immutable policy, which also has one — the media policy could be deleted and the
 * suite would stay green. So every assertion below starts from the media distribution's
 * `DefaultCacheBehavior`, follows its `CachePolicyId` `Ref` to a logical id, and reads that
 * resource. The link is the thing being tested as much as the values are.
 */
describe('the media distribution', () => {
  const mediaBehaviour = () =>
    byComment('od-media-prod')?.Properties.DistributionConfig.DefaultCacheBehavior as
      | (Dist['Properties']['DistributionConfig']['DefaultCacheBehavior'] & {
          AllowedMethods?: string[];
          Compress?: boolean;
          CachePolicyId?: { Ref?: string };
          ResponseHeadersPolicyId?: { Ref?: string };
        })
      | undefined;

  /** The cache policy this distribution actually points at, not merely one that exists. */
  const mediaCachePolicy = () => {
    const ref = mediaBehaviour()?.CachePolicyId?.Ref;
    expect(ref).toBeDefined();
    const policies = prod.web.findResources('AWS::CloudFront::CachePolicy') as Record<
      string,
      { Properties: { CachePolicyConfig: Record<string, unknown> } }
    >;
    const policy = policies[ref as string];
    expect(policy, `no cache policy named ${String(ref)}`).toBeDefined();
    return policy.Properties.CachePolicyConfig as {
      DefaultTTL: number;
      MinTTL: number;
      MaxTTL: number;
      ParametersInCacheKeyAndForwardedToOrigin: {
        EnableAcceptEncodingGzip: boolean;
        EnableAcceptEncodingBrotli: boolean;
        CookiesConfig: { CookieBehavior: string };
        HeadersConfig: { HeaderBehavior: string };
        QueryStringsConfig: { QueryStringBehavior: string };
      };
    };
  };

  /**
   * A year, and safe precisely because the objects are immutable: the key carries a ULID
   * (ADR-023), so a changed image is a new key and there is nothing to invalidate. A short
   * TTL here would buy nothing and cost an S3 GET per edge per expiry — and `cost-model.md`
   * §2.5's "a cached image is zero S3 GETs" is the line this holds up.
   */
  it('caches for a year by default, and never longer', () => {
    const policy = mediaCachePolicy();
    expect(policy.DefaultTTL).toBe(365 * 24 * 60 * 60);
    expect(policy.MaxTTL).toBe(365 * 24 * 60 * 60);
  });

  /**
   * The floor matters as much as the ceiling. Without a `MinTTL`, an origin response
   * carrying `Cache-Control: no-cache` would make every request a miss — and a presigned
   * upload's stored metadata is not something this service controls tightly enough to bet
   * the cache on.
   */
  it('holds a one-day floor under the cache', () => {
    expect(mediaCachePolicy().MinTTL).toBe(24 * 60 * 60);
  });

  it('negotiates gzip and brotli', () => {
    const parameters = mediaCachePolicy().ParametersInCacheKeyAndForwardedToOrigin;
    expect(parameters.EnableAcceptEncodingGzip).toBe(true);
    expect(parameters.EnableAcceptEncodingBrotli).toBe(true);
  });

  /**
   * **The cache key is the path and nothing else.** A forwarded cookie, header or query
   * string would fragment the cache per-viewer and turn a one-year TTL into a hit rate of
   * roughly zero — the failure that looks like a cost problem rather than a config one.
   */
  it('keys the cache on the path alone', () => {
    const parameters = mediaCachePolicy().ParametersInCacheKeyAndForwardedToOrigin;
    expect(parameters.CookiesConfig.CookieBehavior).toBe('none');
    expect(parameters.HeadersConfig.HeaderBehavior).toBe('none');
    expect(parameters.QueryStringsConfig.QueryStringBehavior).toBe('none');
  });

  /** Reads only. Uploads go straight to S3 on a presigned `PUT`, never through the CDN. */
  it('serves GET and HEAD and nothing else', () => {
    expect(mediaBehaviour()?.AllowedMethods).toEqual(['GET', 'HEAD']);
  });

  it('compresses at the edge', () => {
    expect(mediaBehaviour()?.Compress).toBe(true);
  });

  it('answers on IPv6', () => {
    const cfg = byComment('od-media-prod')?.Properties.DistributionConfig as {
      IPV6Enabled?: boolean;
    };
    expect(cfg.IPV6Enabled).toBe(true);
  });

  /**
   * **`OriginAccessIdentity` is present and empty**, which is what "OAC, never OAI" looks
   * like in a synthesized template — CloudFormation still requires the member on an
   * `S3OriginConfig`. A distribution that had actually fallen back to the legacy mechanism
   * would carry an identity path here, so the emptiness is the assertion.
   */
  it('carries no origin access identity', () => {
    const origins =
      byComment('od-media-prod')?.Properties.DistributionConfig.Origins ?? [];
    expect(origins).toHaveLength(1);
    for (const origin of origins as Array<{
      OriginAccessControlId?: unknown;
      S3OriginConfig?: { OriginAccessIdentity?: string };
    }>) {
      expect(origin.OriginAccessControlId).toBeDefined();
      expect(origin.S3OriginConfig?.OriginAccessIdentity).toBe('');
    }
  });

  /**
   * The media distribution has its own response-headers policy. `aws-services.md` §1.6
   * describes one only for the web distribution, so this is the code doing **more** than the
   * document asks — recorded rather than trimmed, because an image served without `nosniff`
   * is an image a browser may decide is a script.
   */
  it('sends HSTS and nosniff on every image', () => {
    const ref = mediaBehaviour()?.ResponseHeadersPolicyId?.Ref;
    expect(ref).toBeDefined();
    const policies = prod.web.findResources(
      'AWS::CloudFront::ResponseHeadersPolicy',
    ) as Record<
      string,
      {
        Properties: {
          ResponseHeadersPolicyConfig: {
            SecurityHeadersConfig?: {
              ContentTypeOptions?: { Override: boolean };
              StrictTransportSecurity?: {
                AccessControlMaxAgeSec: number;
                IncludeSubdomains: boolean;
                Preload: boolean;
                Override: boolean;
              };
            };
          };
        };
      }
    >;
    const security =
      policies[ref as string]?.Properties.ResponseHeadersPolicyConfig
        .SecurityHeadersConfig;

    expect(security?.ContentTypeOptions?.Override).toBe(true);
    expect(security?.StrictTransportSecurity).toMatchObject({
      AccessControlMaxAgeSec: 730 * 24 * 60 * 60,
      IncludeSubdomains: true,
      Preload: true,
      Override: true,
    });
  });

  /**
   * `aws-services.md` §1.6 specifies "TLS 1.2 minimum" for both distributions, and no
   * `MinimumProtocolVersion` is synthesized today. That is not a gap: CloudFront pins the
   * minimum for the default `*.cloudfront.net` certificate and rejects an override, so the
   * setting is only expressible alongside a custom certificate. The code puts all three —
   * alias, certificate and TLS minimum — in one conditional block for that reason, and this
   * asserts the block is off as a unit rather than partly applied.
   */
  it('sets no TLS minimum while it has no certificate to set one on', () => {
    const cfg = byComment('od-media-prod')?.Properties.DistributionConfig as {
      Aliases?: unknown;
      ViewerCertificate?: Record<string, unknown>;
    };
    expect(cfg.Aliases).toBeUndefined();
    expect(JSON.stringify(cfg.ViewerCertificate ?? {})).not.toContain(
      'MinimumProtocolVersion',
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

  /**
   * The other half, which went untested until P0-19 because there was no export to build.
   * Phase 4 CI builds it before deploying, so this branch is the one that actually runs in
   * an environment — and a guard that silently skipped for a bad reason would look exactly
   * like the passing case above.
   */
  it('emits exactly one deployment once the export exists', () => {
    const built = build('prod', BUILT);
    built.web.resourceCountIs('Custom::CDKBucketDeployment', 1);
    built.web.hasResourceProperties('Custom::CDKBucketDeployment', {
      DistributionPaths: ['/*'],
      Prune: true,
    });
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
