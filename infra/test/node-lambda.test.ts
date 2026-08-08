import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { getConfig } from '../lib/config.js';
import { NodeLambda } from '../lib/constructs/node-lambda.js';

/**
 * Every Lambda in the product goes through `NodeLambda`, so what this construct emits is
 * what every function inherits. These assertions are the reason a later task cannot quietly
 * ship an x86 function, a Node 20 runtime, or plaintext logs.
 */

const ENTRY = fileURLToPath(new URL('./fixtures/handler.ts', import.meta.url));

function synth(stage: 'dev' | 'prod', props: { reservedConcurrency?: number } = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, `test-${stage}`);
  new NodeLambda(stack, 'Subject', {
    cfg: getConfig(stage),
    name: 'api',
    entry: ENTRY,
    ...props,
  });
  return Template.fromStack(stack);
}

describe('NodeLambda', () => {
  it('pins the runtime, architecture and log format', () => {
    synth('dev').hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      LoggingConfig: Match.objectLike({ LogFormat: 'JSON' }),
    });
  });

  it('names the function od-<name>-<stage>', () => {
    synth('prod').hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'od-api-prod',
    });
  });

  it('defaults to 1024 MB and a 15 second timeout', () => {
    synth('dev').hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 1024,
      Timeout: 15,
    });
  });

  it('injects STAGE into the environment', () => {
    synth('dev').hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ STAGE: 'dev' }) },
    });
  });

  it('logs at DEBUG in dev and INFO in prod', () => {
    synth('dev').hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: Match.objectLike({ ApplicationLogLevel: 'DEBUG' }),
    });
    synth('prod').hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: Match.objectLike({ ApplicationLogLevel: 'INFO' }),
    });
  });

  it('sets reserved concurrency only when asked', () => {
    synth('dev', { reservedConcurrency: 20 }).hasResourceProperties(
      'AWS::Lambda::Function',
      { ReservedConcurrentExecutions: 20 },
    );
    synth('dev').hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: Match.absent(),
    });
  });

  it('takes log retention from cfg', () => {
    synth('dev').hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
    synth('prod').hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  /**
   * The reason this construct uses `logGroup` rather than the deprecated `logRetention`
   * prop the §1.3 snippet shows. `logRetention` provisions a `Custom::LogRetention` backed
   * by a singleton Lambda and its own IAM role, which then calls `PutRetentionPolicy` at
   * deploy time — three extra resources, and a second Lambda that did not go through this
   * construct, to set one integer CloudFormation can set directly.
   */
  it('provisions no log-retention custom resource', () => {
    const template = synth('prod');
    expect(Object.keys(template.findResources('Custom::LogRetention'))).toEqual([]);
    template.resourceCountIs('AWS::Logs::LogGroup', 1);
  });

  it('emits exactly one Lambda function, so nothing sneaks in beside it', () => {
    synth('dev').resourceCountIs('AWS::Lambda::Function', 1);
  });
});
