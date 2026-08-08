import { existsSync } from 'node:fs';
import { Duration, Stack } from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { fromWorkspaceRoot } from '../paths.js';

/**
 * A private S3 bucket behind a CloudFront distribution, read through Origin Access Control.
 *
 * The bucket is **never** readable from the internet. S3 static website hosting was
 * rejected outright: it requires a public bucket, offers no HTTPS on a custom domain, no
 * HTTP/2, and no control over cache headers (`aws-services.md` §1.6).
 *
 * OAC, not OAI — OAI is the legacy mechanism and CDK itself recommends against it.
 */
export interface StaticSiteProps {
  readonly cfg: EnvConfig;
  /** Becomes `od-<name>-<stage>-<account>`. */
  readonly name: string;
  /** Directory whose contents are uploaded, relative to the workspace root. */
  readonly sourcePath: string;
  /** The CloudFront Function source. */
  readonly uriRewriteCode: string;
  /** Alternate domain name. Phase 5; absent until then. */
  readonly domainName?: string;
  /**
   * Edge certificate, which CloudFront requires in `us-east-1`.
   *
   * A **construct**, never an ARN string: CloudFormation orders the certificate before the
   * distribution only when there is a real dependency edge between them.
   */
  readonly certificate?: acm.ICertificate;
}

export class StaticSite extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id);
    const { cfg } = props;

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `od-${props.name}-${cfg.stage}-${Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // On, unlike the media bucket: a bad web deploy is rolled back by re-uploading, and
      // versions are what make that possible without a rebuild.
      versioned: true,
      removalPolicy: cfg.removalPolicy,
      autoDeleteObjects: false,
    });

    // One origin, shared by both behaviours. Building it twice would create two Origin
    // Access Controls for the same bucket.
    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);

    const rewrite = new cloudfront.Function(this, 'UriRewrite', {
      code: cloudfront.FunctionCode.fromInline(props.uriRewriteCode),
      // JS 2.0 rather than the 1.0 default: it is the current runtime and supports the
      // ECMAScript that this repository's formatter produces.
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: `URI rewrite for od-${props.name}-${cfg.stage}`,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `od-${props.name}-${cfg.stage}`,
      defaultRootObject: 'index.html',
      // North America + Europe. Cheaper, and our users are not yet elsewhere.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        // HTML and anything unhashed: revalidate every time, so a deploy is visible
        // immediately rather than after a TTL nobody remembers setting.
        cachePolicy: this.htmlCachePolicy(),
        responseHeadersPolicy: this.headersPolicy(
          cfg,
          'Default',
          'no-store, must-revalidate',
        ),
        functionAssociations: [
          { function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        // Expo writes content-hashed filenames here, so the bytes at a given URL can never
        // change. A year plus `immutable` means a returning visitor re-downloads nothing.
        '/_expo/static/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: this.immutableCachePolicy(),
          responseHeadersPolicy: this.headersPolicy(
            cfg,
            'Immutable',
            'public, max-age=31536000, immutable',
          ),
        },
      },
      ...(props.domainName !== undefined &&
        props.certificate !== undefined && {
          domainNames: [props.domainName],
          certificate: props.certificate,
          minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        }),
    });

    this.deployIfBuilt(props);
  }

  /**
   * `BucketDeployment` fails **at synth** when its source directory is missing, and in
   * Phase 0 `apps/mobile/dist` usually is — the web export is not built until P0-19.
   *
   * Skipping when absent is what keeps `cdk synth` green in CI without building the export
   * first. The guard must survive into Phase 4, where CI does build it before deploying: it
   * is a guard, not a temporary workaround, and removing it would make every synth depend
   * on a completed Expo build.
   */
  private deployIfBuilt(props: StaticSiteProps): void {
    const source = fromWorkspaceRoot(props.sourcePath);
    if (!existsSync(source)) return;

    new s3deploy.BucketDeployment(this, 'Deploy', {
      sources: [s3deploy.Source.asset(source)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
    });
  }

  private htmlCachePolicy(): cloudfront.CachePolicy {
    return new cloudfront.CachePolicy(this, 'HtmlCachePolicy', {
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
  }

  private immutableCachePolicy(): cloudfront.CachePolicy {
    return new cloudfront.CachePolicy(this, 'ImmutableCachePolicy', {
      defaultTtl: Duration.days(365),
      minTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
  }

  /**
   * HSTS, nosniff, referrer policy, frame deny, a permissions policy denying
   * camera/microphone/geolocation/payment, and a **report-only** CSP.
   *
   * Report-only, and delivered as a custom header rather than through
   * `securityHeadersBehavior.contentSecurityPolicy`, because CloudFront's response-headers
   * policy has no report-only mode — its built-in CSP field is always enforcing. P5-06
   * moves the same string into that field once a real export has been loaded in a browser
   * and the violation reports are empty. Shipping it enforcing now, against a bundle nobody
   * has run, would mean discovering a mistake as a blank page.
   */
  private headersPolicy(
    cfg: EnvConfig,
    suffix: string,
    cacheControl: string,
  ): cloudfront.ResponseHeadersPolicy {
    return new cloudfront.ResponseHeadersPolicy(this, `SecurityHeaders${suffix}`, {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy:
            cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
            override: true,
          },
          {
            header: 'Content-Security-Policy-Report-Only',
            value: contentSecurityPolicy(cfg),
            override: true,
          },
          { header: 'Cache-Control', value: cacheControl, override: true },
        ],
      },
    });
  }
}

/**
 * `security-privacy.md` §4.3, built from `cfg` so the host allow-list cannot drift from the
 * domains actually deployed. In Phase 0 no domain is set, so the media and API hosts are
 * simply absent rather than hard-coded against a domain nobody owns yet.
 *
 * `style-src 'unsafe-inline'` is required because React Native Web injects styles at
 * runtime. It is an accepted, documented weakening: inline **style** injection is a far
 * weaker primitive than inline **script**, and `script-src 'self'` — the one that matters —
 * has no unsafe directives.
 */
export function contentSecurityPolicy(cfg: EnvConfig): string {
  const img = ["'self'", 'data:', 'blob:'];
  const connect = ["'self'", 'https://cognito-idp.us-east-1.amazonaws.com'];
  if (cfg.mediaDomain !== undefined) img.push(`https://${cfg.mediaDomain}`);
  if (cfg.apiDomain !== undefined) connect.push(`https://${cfg.apiDomain}`);

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${img.join(' ')}`,
    `connect-src ${connect.join(' ')}`,
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}
