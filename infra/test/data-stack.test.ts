import { GSI1_PROJECTED_ATTRIBUTES, TABLE } from '@od/shared/table';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { getConfig } from '../lib/config.js';
import { DataStack } from '../lib/stacks/data-stack.js';

const template = (stage: 'dev' | 'prod') =>
  Template.fromStack(
    new DataStack(new cdk.App(), `od-data-${stage}`, { cfg: getConfig(stage) }),
  );

const dev = template('dev');
const prod = template('prod');

describe('the table', () => {
  it('is named od-main-<stage> and billed on demand', () => {
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'od-main-dev',
      BillingMode: 'PAY_PER_REQUEST',
    });
    prod.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'od-main-prod' });
  });

  it('keys on pk/sk as strings', () => {
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ]),
    });
  });

  it('enables TTL on the attribute the shared definition names', () => {
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: TABLE.ttlAttribute, Enabled: true },
    });
  });

  /**
   * One GSI, and only one. Every additional index is a second write on every mutation, and
   * adding one requires a written justification in `data-model.md` (`CLAUDE.md`). If this
   * test fails because a second index was added, that justification is the missing work —
   * not this assertion.
   */
  it('declares exactly one global secondary index', () => {
    const tables = Object.values(dev.findResources('AWS::DynamoDB::Table')) as Array<{
      Properties: { GlobalSecondaryIndexes?: unknown[] };
    }>;
    expect(tables).toHaveLength(1);
    expect(tables[0]?.Properties.GlobalSecondaryIndexes).toHaveLength(1);
  });

  /**
   * `INCLUDE`, never `ALL`. Getting this wrong is invisible until the agenda query's cost
   * and latency are wrong at scale, and a projection cannot be altered in place — changing
   * it means replacing the index.
   */
  it('projects INCLUDE with exactly the shared definition’s attributes', () => {
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'INCLUDE',
            NonKeyAttributes: [...GSI1_PROJECTED_ATTRIBUTES],
          },
        }),
      ],
    });
  });

  /**
   * The anti-drift assertion. The stack must contain nothing the shared definition does not
   * describe, because the local table script (P0-21) and the integration harness build
   * their tables from that same object.
   */
  it('takes its whole shape from @od/shared/table', () => {
    const table = (
      Object.values(dev.findResources('AWS::DynamoDB::Table')) as Array<{
        Properties: {
          KeySchema: Array<{ AttributeName: string }>;
          GlobalSecondaryIndexes: Array<{
            IndexName: string;
            KeySchema: Array<{ AttributeName: string }>;
          }>;
        };
      }>
    )[0];

    expect(table?.Properties.KeySchema.map((k) => k.AttributeName)).toEqual([
      TABLE.partitionKey,
      TABLE.sortKey,
    ]);
    expect(table?.Properties.GlobalSecondaryIndexes.map((g) => g.IndexName)).toEqual(
      TABLE.indexes.map((i) => i.name),
    );
    expect(
      table?.Properties.GlobalSecondaryIndexes[0]?.KeySchema.map((k) => k.AttributeName),
    ).toEqual([TABLE.indexes[0].partitionKey, TABLE.indexes[0].sortKey]);
  });

  // Phase 7 turns these on for balance recalculation and notification fan-out. Enabling a
  // stream before there is a consumer is a charge for nothing.
  it('has streams off in Phase 0', () => {
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: Match.absent(),
    });
  });

  it('protects prod and leaves dev disposable', () => {
    prod.hasResourceProperties('AWS::DynamoDB::Table', {
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      DeletionProtectionEnabled: false,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
    });
    prod.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    dev.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });
});

describe('the media bucket', () => {
  /**
   * `infrastructure.md` §2.3: `od-<purpose>-<stage>-<account-id>`, because bucket names are
   * globally unique across all of AWS and `od-media-prod` is long since taken. The account
   * id is a `Ref`, not a literal, so the same synth works in any account.
   *
   * `aws-services.md` §1.5 and §1.6 write the bucket as `od-media-{env}` throughout. That is
   * shorthand for the bucket's purpose, not a competing naming rule — §2.3 is canonical for
   * names and is the one with the worked example.
   */
  it('is named od-media-<stage>-<account>', () => {
    dev.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: { 'Fn::Join': ['', ['od-media-dev-', { Ref: 'AWS::AccountId' }]] },
    });
    prod.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: { 'Fn::Join': ['', ['od-media-prod-', { Ref: 'AWS::AccountId' }]] },
    });
  });

  it('blocks public access on all four settings', () => {
    dev.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('encrypts with SSE-S3 and is not versioned', () => {
    dev.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      VersioningConfiguration: Match.absent(),
    });
  });

  it('carries the three lifecycle rules', () => {
    dev.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          }),
          Match.objectLike({
            Transitions: [{ StorageClass: 'INTELLIGENT_TIERING', TransitionInDays: 90 }],
          }),
          Match.objectLike({ Prefix: 'tmp/', ExpirationInDays: 1 }),
        ]),
      },
    });
  });

  /**
   * **Three, and exactly three, and all of them on** (P3-23).
   *
   * `Match.arrayWith` above is a subset match, so a fourth rule — or a rule left
   * `Status: 'Disabled'` — passes it. Both are worth catching: a disabled expiry on `tmp/`
   * is an unbounded pile of unconfirmed uploads that nothing else in the product would
   * notice, and `infrastructure.md` §6.1 is explicit that MinIO models none of this, so
   * these assertions carry the rules until Phase 5 exercises them for real.
   */
  it('has no fourth rule, and every rule is enabled', () => {
    const buckets = Object.values(dev.findResources('AWS::S3::Bucket')) as Array<{
      Properties: {
        LifecycleConfiguration?: { Rules: Array<{ Id: string; Status: string }> };
      };
    }>;
    const rules = buckets.flatMap(
      (b) => b.Properties.LifecycleConfiguration?.Rules ?? [],
    );

    expect(rules.map((rule) => rule.Id).sort()).toEqual([
      'abort-incomplete-multipart',
      'expire-tmp',
      'intelligent-tiering-after-90d',
    ]);
    for (const rule of rules) expect(rule.Status).toBe('Enabled');
  });

  /**
   * The `tmp/` rule **expires** rather than transitions, and it is the only prefixed rule.
   *
   * An unconfirmed upload is rubbish after a day (`api-contract.md` §2.6); tiering it to a
   * cheaper class would keep it for ever at a discount, which is the opposite of what the
   * rule is for. The other two are bucket-wide on purpose — they apply to confirmed media
   * at `u/<userId>/…` as well.
   */
  it('expires tmp/ rather than tiering it, and prefixes nothing else', () => {
    const buckets = Object.values(dev.findResources('AWS::S3::Bucket')) as Array<{
      Properties: {
        LifecycleConfiguration?: {
          Rules: Array<{
            Id: string;
            Prefix?: string;
            Transitions?: unknown;
            ExpirationInDays?: number;
          }>;
        };
      };
    }>;
    const rules = buckets.flatMap(
      (b) => b.Properties.LifecycleConfiguration?.Rules ?? [],
    );

    const tmp = rules.find((rule) => rule.Id === 'expire-tmp');
    expect(tmp?.Prefix).toBe('tmp/');
    expect(tmp?.ExpirationInDays).toBe(1);
    expect(tmp?.Transitions).toBeUndefined();

    expect(rules.filter((rule) => rule.Prefix !== undefined)).toHaveLength(1);
  });

  /**
   * Nothing here carries an hourly charge, and `cost-model.md` §2.5 prices exactly one
   * bucket per environment. A second one appearing in this stack is a cost decision that
   * should arrive as a doc row first.
   */
  it('is the only bucket DataStack creates', () => {
    dev.resourceCountIs('AWS::S3::Bucket', 1);
  });

  // An empty AllowedOrigins list is not valid CloudFormation, and no stage has a web origin
  // until Phase 5 registers the domain.
  it('omits CORS while there are no web origins', () => {
    expect(getConfig('dev').webOrigins).toEqual([]);
    dev.hasResourceProperties('AWS::S3::Bucket', { CorsConfiguration: Match.absent() });
  });

  /**
   * A wildcard principal is only dangerous on an `Allow`. `enforceSSL` deliberately emits
   * `Deny s3:* to Principal {"AWS":"*"} when aws:SecureTransport is false` — denying
   * everyone non-TLS access is the point of it, so the effect has to be part of the test.
   */
  it('grants no public access, while keeping the deny-non-TLS statement', () => {
    const policies = Object.values(dev.findResources('AWS::S3::BucketPolicy')) as Array<{
      Properties: {
        PolicyDocument: {
          Statement: Array<{ Effect: string; Principal?: unknown; Condition?: unknown }>;
        };
      };
    }>;

    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    expect(statements.length).toBeGreaterThan(0);

    for (const s of statements) {
      if (s.Effect !== 'Allow') continue;
      const principal = JSON.stringify(s.Principal ?? null);
      expect(principal).not.toContain('"*"');
      expect(principal).not.toBe('"*"');
    }

    const denies = statements.filter((s) => s.Effect === 'Deny');
    expect(JSON.stringify(denies)).toContain('aws:SecureTransport');
  });

  /**
   * **`s3:GetObject`, on objects, and nothing else** (P3-23).
   *
   * `web-stack.test.ts` asserts the *condition* on this statement, because the reason it is
   * an account condition rather than an exact distribution ARN is a `WebStack` fact. What
   * nothing asserted is the grant's own width: an action list that had grown to `s3:*`, or a
   * resource that had picked up the bucket ARN alongside the object ARN, would satisfy every
   * condition assertion and still be a hole.
   *
   * Both widenings matter. `s3:*` would let CloudFront write and delete user media, and
   * ADR-023 turns on reads being the only thing anyone but a presigned `PUT` can do. Adding
   * the bucket ARN would permit `s3:ListBucket`, which turns the unguessable ULID key — the
   * entire privacy mechanism in ADR-023 — into a directory listing.
   */
  it('grants CloudFront s3:GetObject on objects only', () => {
    const statement = Object.values(dev.findResources('AWS::S3::BucketPolicy'))
      .flatMap(
        (p) =>
          (
            p as {
              Properties: {
                PolicyDocument: {
                  Statement: Array<{
                    Sid?: string;
                    Action?: unknown;
                    Resource?: unknown;
                  }>;
                };
              };
            }
          ).Properties.PolicyDocument.Statement,
      )
      .find((s) => s.Sid === 'AllowCloudFrontOacRead');

    expect(statement).toBeDefined();
    // A bare string, not a one-element list: a list is how a second action arrives.
    expect(statement?.Action).toBe('s3:GetObject');

    const bucketIds = Object.keys(dev.findResources('AWS::S3::Bucket'));
    expect(bucketIds).toHaveLength(1);
    expect(statement?.Resource).toEqual({
      'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketIds[0], 'Arn'] }, '/*']],
    });
  });
});
