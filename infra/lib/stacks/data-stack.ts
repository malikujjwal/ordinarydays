import { TABLE, tableName } from '@od/shared/table';
import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { applyStackTags } from '../tags.js';

/**
 * `od-data-{stage}` — the stateful stack: the DynamoDB table and the media bucket
 * (`infrastructure.md` §1.1).
 *
 * Purely stateful by design. The media **CloudFront distribution** lives in `WebStack`, not
 * here, so that every distribution and cache policy is in one file and this stack never
 * needs touching for a front-end change (§1.1, adjustment 1).
 *
 * **Every key attribute, index name and projected attribute is read from
 * `@od/shared/table`.** This stack maps that plain data onto CDK constructs and adds
 * nothing to it. The same definition is mapped onto a `CreateTableCommand` by the local
 * table script (P0-21) and onto a per-file test table by the integration harness, so the
 * three cannot drift (`repo-structure.md` §3).
 *
 * Free-tier buckets (`cost-model.md`): DynamoDB §2.4 — 25 GB of storage, always free; note
 * the always-free 25 RCU/WCU applies to provisioned mode only and does not cover on-demand
 * request charges. S3 §2.6 — 5 GB Standard, 20,000 GET and 2,000 PUT, **12 months only**.
 * Nothing here carries an hourly charge.
 */
export interface DataStackProps extends cdk.StackProps {
  cfg: EnvConfig;
}

export class DataStack extends cdk.Stack {
  readonly table: dynamodb.Table;
  readonly mediaBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'data', props.cfg.stage);

    this.table = this.createTable(props.cfg);
    this.mediaBucket = this.createMediaBucket(props.cfg);
    this.allowCloudFrontRead();
  }

  /**
   * Lets CloudFront read the media bucket through Origin Access Control.
   *
   * **The condition is `aws:SourceAccount`, not the distribution's ARN**, and that is a
   * deliberate, narrow weakening rather than an oversight.
   *
   * OAC normally conditions on the exact distribution ARN. That ARN is only known once the
   * distribution exists, and the distribution lives in `WebStack` (§1.1 adjustment 1) while
   * this bucket lives here — so an ARN condition would make `DataStack` depend on
   * `WebStack` while `WebStack` already depends on `DataStack` for the origin domain. That
   * is a genuine CloudFormation dependency cycle, not something a different construct order
   * can avoid.
   *
   * What the condition defends against is the confused-deputy case: **someone else's**
   * CloudFront distribution being pointed at this bucket. `aws:SourceAccount` closes that
   * completely. What it no longer prevents is another distribution *inside this account*
   * reading the bucket — and every distribution in this single-tenant account is authored
   * in this repository. The wildcard ARN below adds nothing enforceable beyond the account
   * condition; it is there so the intent reads correctly to the next person.
   *
   * Recorded in `security-privacy.md` §1 and `infrastructure.md` §1.1.
   */
  private allowCloudFrontRead(): void {
    this.mediaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontOacRead',
        actions: ['s3:GetObject'],
        resources: [this.mediaBucket.arnForObjects('*')],
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        conditions: {
          StringEquals: { 'AWS:SourceAccount': this.account },
          ArnLike: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/*`,
          },
        },
      }),
    );
  }

  private createTable(cfg: EnvConfig): dynamodb.Table {
    const [gsi1] = TABLE.indexes;

    const table = new dynamodb.Table(this, 'Main', {
      tableName: tableName(cfg.stage),
      // On-demand. At personal and early-beta scale this is a few cents a month, and it
      // removes capacity planning entirely (`data-model.md` §2).
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: TABLE.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: TABLE.sortKey, type: dynamodb.AttributeType.STRING },
      // Epoch seconds. Used by invite tokens, idempotency records and rate-limit counters.
      timeToLiveAttribute: TABLE.ttlAttribute,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: cfg.pointInTimeRecovery,
      },
      deletionProtection: cfg.stage === 'prod',
      removalPolicy: cfg.removalPolicy,
      // Streams are OFF in Phase 0. Phase 7 turns them on (NEW_AND_OLD_IMAGES) for balance
      // recalculation and notification fan-out; enabling them before there is a consumer
      // is a charge for nothing.
    });

    /**
     * The one and only index. Every additional index is a second write on every mutation,
     * and adding one requires a written justification in `data-model.md` (`CLAUDE.md`).
     *
     * Projection is `INCLUDE`, never `ALL`. The agenda query is the hottest read in the
     * product; a narrower projection is fewer RCUs and less GSI storage. Getting this wrong
     * is invisible until cost and latency are wrong at scale, and a projection cannot be
     * altered in place — changing it means replacing the index.
     */
    table.addGlobalSecondaryIndex({
      indexName: gsi1.name,
      partitionKey: { name: gsi1.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: gsi1.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [...gsi1.nonKeyAttributes],
    });

    return table;
  }

  private createMediaBucket(cfg: EnvConfig): s3.Bucket {
    return new s3.Bucket(this, 'Media', {
      // S3 bucket names are globally unique, so the account id is part of the name.
      bucketName: `od-media-${cfg.stage}-${this.account}`,
      // All four settings. There is no scenario in this app where an S3 object should be
      // world-readable directly; CloudFront reads it through OAC, granted in WebStack.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // SSE-S3, not SSE-KMS: KMS adds a per-request charge for no meaningful gain on a
      // bucket that is already private and single-tenant (`aws-services.md` §1.5).
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Off, deliberately: versioning user uploads doubles storage for no product benefit.
      // `od-web-{stage}` in WebStack does version, so a bad web deploy can be rolled back.
      versioned: false,
      removalPolicy: cfg.removalPolicy,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: 'abort-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        {
          id: 'intelligent-tiering-after-90d',
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: Duration.days(90),
            },
          ],
        },
        // `tmp/` is where a presigned upload lands before it is confirmed and linked to an
        // activity. An unconfirmed upload is rubbish after a day.
        { id: 'expire-tmp', prefix: 'tmp/', expiration: Duration.days(1) },
      ],
      // Presigned browser PUTs need CORS, but only the web build makes them and there are
      // no web origins until Phase 5 registers the domain. An empty AllowedOrigins list is
      // not valid CloudFormation, so the rule appears only once there is an origin.
      ...(cfg.webOrigins.length > 0 && {
        cors: [
          {
            allowedMethods: [s3.HttpMethods.PUT],
            allowedOrigins: [...cfg.webOrigins],
            allowedHeaders: ['*'],
            maxAge: 3000,
          },
        ],
      }),
    });
  }
}
