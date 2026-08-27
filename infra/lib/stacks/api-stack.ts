import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { NodeLambda } from '../constructs/node-lambda.js';
import { API_ENTRY } from '../paths.js';
import { applyStackTags } from '../tags.js';
import type { AuthStack } from './auth-stack.js';
import type { DataStack } from './data-stack.js';
import type { DnsStack } from './dns-stack.js';

/**
 * `od-api-{stage}` — the single Lambda and the HTTP API in front of it
 * (`infrastructure.md` §1.1, `aws-services.md` §1.2).
 *
 * One `$default` route with a Lambda proxy integration. **All routing happens inside Hono.**
 * Declaring sixty routes in API Gateway would duplicate `api-contract.md` in a second place
 * that can silently disagree with it. There is no API Gateway authorizer either: auth
 * happens in the Lambda so the public invite routes and the authenticated routes share one
 * code path and one error envelope.
 *
 * Free-tier buckets (`cost-model.md`): Lambda §2.3 — **always free**, 1M requests and
 * 400,000 GB-seconds/month. API Gateway §2.2 — **12 months only**, 1M HTTP API calls/month,
 * then $1.00/M; this is the clearest 12-month cliff in the project. CloudWatch Logs §2.12 —
 * always free, 5 GB ingestion and 5 GB storage/month, which cfg-driven retention is what
 * keeps us inside. IAM is free at any scale. Nothing here carries an hourly charge, and
 * reserved concurrency is a quota reservation rather than a charge.
 */
export interface ApiStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  dns: DnsStack;
  auth: AuthStack;
  data: DataStack;
}

export class ApiStack extends cdk.Stack {
  readonly fn: lambda.IFunction;
  readonly alias: lambda.Alias;
  readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'api', props.cfg.stage);

    const { cfg, data } = props;

    const api = new NodeLambda(this, 'Api', {
      cfg,
      name: 'api',
      entry: API_ENTRY,
      memorySize: 1024,
      timeoutSeconds: 15,
      reservedConcurrency: cfg.apiReservedConcurrency,
      // Identifiers only, never a secret (`security-privacy.md` §6.2). These keys are
      // exactly what `services/api/src/lib/config.ts` parses — a mismatch is a cold-start
      // crash that synth cannot see, so a test asserts the correspondence.
      environment: {
        TABLE_NAME: data.table.tableName,
        MEDIA_BUCKET: data.mediaBucket.bucketName,
        LOG_LEVEL: cfg.stage === 'prod' ? 'info' : 'debug',
        GIT_SHA: process.env.GITHUB_SHA ?? 'local',
        WEB_ORIGINS: cfg.webOrigins.join(','),
        /**
         * **A literal, never a parameter** (P1-02, mechanism 2 of three).
         *
         * `AUTH_MODE=local` makes the API run `LocalIdentityProvider`, which returns the
         * constant `usr_local_dev` for every caller — one shared account holding everybody's
         * data, silently. Deployed functions must never be able to reach that mode, so this
         * is hard-coded here rather than read from `cfg`, `process.env` or a context value:
         * there is no input to this stack that can change it, which is what makes the
         * failure impossible at **synth** rather than merely unlikely at runtime.
         *
         * `cognito` names a provider Phase 4 (P4-05) implements. Until then a deployed
         * function refuses to start, which is the correct behaviour for a stage that has no
         * working identity — and is safe because nothing is deployed before Phase 4.
         */
        AUTH_MODE: 'cognito',
      },
      // STAGE is set by NodeLambda for every function.
    });
    this.fn = api.fn;

    /**
     * A published version behind a `live` alias, from day one.
     *
     * Rolling back a bad deploy is then `aws lambda update-alias`, in seconds, with no
     * build and no CloudFormation (`infrastructure.md` §4.4). What makes that work is that
     * the integration below targets the **alias ARN**, never `$LATEST`. Writing it now, in
     * a stack that has never deployed, is free; retrofitting it during an incident is not.
     */
    this.alias = new lambda.Alias(this, 'LiveAlias', {
      aliasName: 'live',
      version: api.fn.currentVersion,
    });

    this.grantDataAccess(props);
    this.httpApi = this.createHttpApi(cfg);
    this.addCustomDomain(props);
  }

  /**
   * The narrowest grants that let the API do its job.
   *
   * `grantReadWriteData` covers the table **and** `GSI1` — CDK grants `table/index/*` — so
   * there is no separate index grant to forget. S3 is scoped to the two prefixes the
   * product actually writes: `u/<userId>/…` for confirmed media and `tmp/` for a presigned
   * upload that has not been linked to an activity yet. Never bucket-wide.
   */
  private grantDataAccess({ data }: ApiStackProps): void {
    data.table.grantReadWriteData(this.fn);

    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        resources: [
          data.mediaBucket.arnForObjects('u/*'),
          data.mediaBucket.arnForObjects('tmp/*'),
        ],
      }),
    );
  }

  private createHttpApi(cfg: EnvConfig): apigwv2.HttpApi {
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `od-api-${cfg.stage}`,
      // Payload format 2.0 is what `hono/aws-lambda` is built around.
      defaultIntegration: new HttpLambdaIntegration('DefaultIntegration', this.alias, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
      // CORS is handled in Hono so there is one CORS configuration, not two.
      createDefaultStage: true,
    });

    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      retention: cfg.logRetentionDays,
      removalPolicy: cfg.removalPolicy,
    });

    // The L2 exposes neither throttling nor access logging, so both are set on the
    // underlying stage. Throttle is a hard ceiling well above expected traffic and well
    // below anything that could produce a bill; per-user limits live in the Lambda.
    const stage = httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = {
      throttlingBurstLimit: 100,
      throttlingRateLimit: 50,
    };
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        routeKey: '$context.routeKey',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        integrationLatency: '$context.integrationLatency',
      }),
    };

    return httpApi;
  }

  /**
   * The custom domain, its certificate and its API mapping.
   *
   * Entered only when **both** `cfg.apiDomain` and the certificate construct exist, which
   * no stage satisfies until Phase 5 registers the domain. Until then the API is reachable
   * on its `execute-api` URL, and that single branch at construction is what lets this stack
   * synthesise with no domain.
   *
   * The certificate is taken as a **construct**, never an ARN string: CDK orders the
   * certificate before the mapping only when there is a real dependency edge between them,
   * and an ARN gives it none (`infrastructure.md` §1.2).
   */
  private addCustomDomain({ cfg, dns }: ApiStackProps): void {
    const certificate = dns.apiCertificate;
    if (cfg.apiDomain === undefined || certificate === undefined) return;

    const domainName = new apigwv2.DomainName(this, 'ApiDomain', {
      domainName: cfg.apiDomain,
      certificate,
    });

    new apigwv2.ApiMapping(this, 'ApiMapping', {
      api: this.httpApi,
      domainName,
      ...(this.httpApi.defaultStage !== undefined && {
        stage: this.httpApi.defaultStage,
      }),
    });

    // Phase 5 adds the Route 53 A-record alias to `domainName` here, from the same
    // construct, for the same ordering reason.
  }
}
