import { readFileSync } from 'node:fs';
import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { StaticSite } from '../constructs/static-site.js';
import { fromWorkspaceRoot } from '../paths.js';
import { applyStackTags } from '../tags.js';
import type { DataStack } from './data-stack.js';
import type { DnsStack } from './dns-stack.js';

/**
 * `od-web-{stage}` — **every CloudFront distribution in the product**
 * (`infrastructure.md` §1.1).
 *
 * The media distribution lives here rather than in `DataStack` so that every distribution
 * and every cache policy is in one file, and `DataStack` stays purely stateful and never
 * needs touching for a front-end change (§1.1, adjustment 1). The media *bucket* still
 * belongs to `DataStack`; only the distribution over it is here.
 *
 * Free-tier buckets (`cost-model.md`): CloudFront §2.6 — **always free**, 1 TB egress and
 * 10M requests/month, of which 1,000 users use about 15%; this is the most comfortable line
 * in the model. S3 §2.5 — 5 GB Standard, **12 months only**. CloudFront Functions are free
 * to 2M invocations/month. Cache policies, response-headers policies and OACs are
 * configuration and carry no charge. Nothing here has an hourly charge.
 */
export interface WebStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  dns: DnsStack;
  data: DataStack;
}

const URI_REWRITE = readFileSync(
  fromWorkspaceRoot('infra', 'lib', 'functions', 'uri-rewrite.js'),
  'utf8',
);

export class WebStack extends cdk.Stack {
  readonly site: StaticSite;
  readonly mediaDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'web', props.cfg.stage);

    const { cfg, dns, data } = props;

    this.site = new StaticSite(this, 'Web', {
      cfg,
      name: 'web',
      sourcePath: 'apps/mobile/dist',
      uriRewriteCode: URI_REWRITE,
      // Both undefined until Phase 5 registers the domain, so the distribution is reachable
      // on its *.cloudfront.net name and carries no ACM certificate.
      ...(cfg.domain !== undefined && { domainName: cfg.domain }),
      ...(dns.edgeCertificate !== undefined && { certificate: dns.edgeCertificate }),
    });

    this.mediaDistribution = this.createMediaDistribution(cfg, dns, data);
  }

  /**
   * The media distribution, over `DataStack`'s bucket.
   *
   * Object keys contain a ULID under a per-user prefix, so they are unguessable, and the
   * API only ever returns keys for images the caller may see. There are **no signed URLs in
   * v1**; that is the Phase 7 hardening step if media ever becomes sensitive enough to
   * justify the key management (`aws-services.md` §1.6, recorded in `decisions.md`).
   *
   * A long TTL is safe because the objects are immutable — the key contains a ULID, so a
   * changed image is a new key.
   */
  private createMediaDistribution(
    cfg: EnvConfig,
    dns: DnsStack,
    data: DataStack,
  ): cloudfront.Distribution {
    const cachePolicy = new cloudfront.CachePolicy(this, 'MediaCachePolicy', {
      defaultTtl: Duration.days(365),
      minTtl: Duration.days(1),
      maxTtl: Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    return new cloudfront.Distribution(this, 'Media', {
      comment: `od-media-${cfg.stage}`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      defaultBehavior: {
        /**
         * The bucket is referenced as an **imported** bucket on purpose.
         *
         * `withOriginAccessControl` normally adds a bucket policy conditioned on this
         * distribution's ARN. Doing that from here would mutate a resource that belongs to
         * `DataStack` and make `DataStack` depend on this stack, while this stack already
         * depends on `DataStack` for the origin domain — a dependency cycle. CDK does not
         * mutate the policy of an imported bucket, so the grant is made once in
         * `DataStack.allowCloudFrontRead()`, conditioned on the account. See the comment
         * there for what that trades away.
         */
        origin: origins.S3BucketOrigin.withOriginAccessControl(
          s3.Bucket.fromBucketAttributes(this, 'MediaBucketRef', {
            bucketName: data.mediaBucket.bucketName,
            bucketRegionalDomainName: data.mediaBucket.bucketRegionalDomainName,
          }),
        ),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy,
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(
          this,
          'MediaHeaders',
          {
            securityHeadersBehavior: {
              contentTypeOptions: { override: true },
              strictTransportSecurity: {
                accessControlMaxAge: Duration.days(730),
                includeSubdomains: true,
                preload: true,
                override: true,
              },
            },
          },
        ),
      },
      ...(cfg.mediaDomain !== undefined &&
        dns.edgeCertificate !== undefined && {
          domainNames: [cfg.mediaDomain],
          certificate: dns.edgeCertificate,
          minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        }),
    });
  }
}
