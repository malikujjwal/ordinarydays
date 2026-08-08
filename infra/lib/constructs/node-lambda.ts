import { Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';

/**
 * The one way a Lambda is created in this project (`infrastructure.md` §1.3).
 *
 * Every function goes through here so that runtime, architecture, bundling format, log
 * retention and log level cannot drift between functions. A second `NodejsFunction`
 * anywhere in `infra/` is a review rejection.
 *
 * `NodejsFunction` bundles with esbuild **at synth time**, which means `cdk synth` in CI
 * actually compiles the API. That is deliberate: it is the cheapest proof that the deployed
 * artifact still builds, and it is most of the value of running synth in a phase that never
 * deploys.
 */
export interface NodeLambdaProps {
  readonly cfg: EnvConfig;
  /** Short name; the function becomes `od-<name>-<stage>`. */
  readonly name: string;
  /** Path to the TypeScript entry point, e.g. `services/api/src/index.ts`. */
  readonly entry: string;
  readonly memorySize?: number;
  readonly timeoutSeconds?: number;
  readonly reservedConcurrency?: number;
  readonly environment?: Record<string, string>;
}

export class NodeLambda extends Construct {
  readonly fn: NodejsFunction;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: NodeLambdaProps) {
    super(scope, id);

    /**
     * An explicit, CloudFormation-managed log group rather than the `logRetention` prop the
     * §1.3 snippet uses. See the note below the class — this is the one deliberate
     * deviation from that snippet, and it is behaviour-preserving for retention.
     *
     * The name is left to CloudFormation. Naming it `/aws/lambda/od-<name>-<stage>`
     * explicitly would collide on any destroy-then-recreate in prod, where the removal
     * policy is RETAIN and the orphaned group would still hold the name.
     */
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: props.cfg.logRetentionDays,
      removalPolicy: props.cfg.removalPolicy,
    });

    this.fn = new NodejsFunction(this, 'Fn', {
      functionName: `od-${props.name}-${props.cfg.stage}`,
      entry: props.entry,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? 1024,
      timeout: Duration.seconds(props.timeoutSeconds ?? 15),
      // Spread rather than assigned: `exactOptionalPropertyTypes` is on, so passing an
      // explicit `undefined` to an optional prop is a type error, not a no-op.
      ...(props.reservedConcurrency !== undefined && {
        reservedConcurrentExecutions: props.reservedConcurrency,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2:
        props.cfg.stage === 'prod'
          ? lambda.ApplicationLogLevel.INFO
          : lambda.ApplicationLogLevel.DEBUG,
      logGroup: this.logGroup,
      environment: { STAGE: props.cfg.stage, ...props.environment },
      bundling: {
        format: OutputFormat.ESM,
        minify: true,
        // Source maps cost boot time, so prod ships without them; the artifact store keeps
        // them instead (`infrastructure.md` §4.5).
        sourceMap: props.cfg.stage !== 'prod',
        target: 'node22',
        mainFields: ['module', 'main'],
        // Required, not optional. An ESM bundle has no `require` in scope, and some
        // transitive dependencies still emit CommonJS `require` calls.
        banner:
          "import{createRequire}from'module';const require=createRequire(import.meta.url);",
      },
    });
  }
}
