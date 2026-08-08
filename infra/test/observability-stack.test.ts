import { readdirSync, readFileSync } from 'node:fs';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { getConfig } from '../lib/config.js';
import { fromWorkspaceRoot } from '../lib/paths.js';
import { ApiStack } from '../lib/stacks/api-stack.js';
import { AuthStack } from '../lib/stacks/auth-stack.js';
import { DataStack } from '../lib/stacks/data-stack.js';
import { DnsStack } from '../lib/stacks/dns-stack.js';
import { ObservabilityStack } from '../lib/stacks/observability-stack.js';
import { SchedulerStack } from '../lib/stacks/scheduler-stack.js';

/**
 * Synthesised once and reused: `ApiStack` runs esbuild over the real API source, so
 * building the dependency chain is seconds rather than milliseconds.
 */
function build(stage: 'dev' | 'prod') {
  const app = new cdk.App();
  const cfg = getConfig(stage);
  const dns = new DnsStack(app, `od-dns-${stage}`, { cfg });
  const auth = new AuthStack(app, `od-auth-${stage}`, { cfg, dns });
  const data = new DataStack(app, `od-data-${stage}`, { cfg });
  const api = new ApiStack(app, `od-api-${stage}`, { cfg, dns, auth, data });
  const scheduler = new SchedulerStack(app, `od-scheduler-${stage}`, { cfg, data, api });
  const observability = new ObservabilityStack(app, `od-observability-${stage}`, {
    cfg,
    api,
    data,
    scheduler,
  });
  return Template.fromStack(observability);
}

const dev = build('dev');
const prod = build('prod');

/**
 * The six alarm names, sorted, as `aws-services.md` §1.12 names them.
 *
 * The `gitleaks:allow` is a false positive on gitleaks' `generic-api-key` rule, verified by
 * running the scan: the rule reads the `api` keyword ending the line above as the name of a
 * credential and `api-p95-latency` as its value, which clears the rule's entropy floor at
 * 3.5. It is an alarm name and it is also the string CloudWatch will show. Left in place
 * rather than reordered around the rule, because a list bent to dodge a regex is a list the
 * next person re-sorts.
 */
const ALARM_NAMES = [
  'api-5xx',
  'api-errors',
  'api-invocations-spike',
  'api-p95-latency', // gitleaks:allow
  'api-throttles',
  'ddb-throttles',
];

interface AlarmProperties {
  AlarmName: string;
  AlarmActions?: unknown[];
  OKActions?: unknown[];
  TreatMissingData?: string;
  Threshold?: number;
  Period?: number;
  EvaluationPeriods?: number;
  ComparisonOperator?: string;
  Metrics?: Array<{ Id: string }>;
}

const alarms = (t: Template): AlarmProperties[] =>
  Object.values(t.findResources('AWS::CloudWatch::Alarm')).map(
    (r) => (r as { Properties: AlarmProperties }).Properties,
  );

const alarmNamed = (t: Template, name: string, stage: string): AlarmProperties => {
  const found = alarms(t).find((a) => a.AlarmName === `od-${name}-${stage}`);
  if (found === undefined) throw new Error(`no alarm named od-${name}-${stage}`);
  return found;
};

describe('the alert topic', () => {
  it('is od-alerts-{stage} with an email subscription to cfg.alertEmail', () => {
    dev.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'od-alerts-dev' });
    prod.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'od-alerts-prod' });
    prod.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: getConfig('prod').alertEmail,
    });
  });

  it('is the only topic — one destination, one subscription to confirm', () => {
    prod.resourceCountIs('AWS::SNS::Topic', 1);
    prod.resourceCountIs('AWS::SNS::Subscription', 1);
  });
});

describe('the alarms', () => {
  /**
   * The set is exact in both directions. Adding an alarm for a resource that does not exist
   * yet — `ses-bounce-rate`, `reminder-errors` — leaves it in `INSUFFICIENT_DATA` forever
   * and teaches the reader to ignore the mail; dropping one leaves a resource unwatched.
   */
  it('are exactly the six that watch resources this phase writes', () => {
    expect(
      alarms(prod)
        .map((a) => a.AlarmName)
        .sort(),
    ).toEqual(ALARM_NAMES.map((n) => `od-${n}-prod`));
    expect(
      alarms(dev)
        .map((a) => a.AlarmName)
        .sort(),
    ).toEqual(ALARM_NAMES.map((n) => `od-${n}-dev`));
  });

  /**
   * The assertion the whole stack rests on. An alarm with no action is a coloured square on
   * a page nobody has open: it passes review, deploys clean, and notifies no one.
   */
  it('every one notifies the alert topic, on breach and on recovery', () => {
    const topicId = Object.keys(prod.findResources('AWS::SNS::Topic'))[0];
    expect(alarms(prod)).toHaveLength(6);
    for (const a of alarms(prod)) {
      expect(a.AlarmActions).toEqual([{ Ref: topicId }]);
      expect(a.OKActions).toEqual([{ Ref: topicId }]);
    }
  });

  /**
   * With the CDK default, `MISSING`, every alarm here would sit in `INSUFFICIENT_DATA`
   * through any quiet period — which at personal scale is most of the day.
   */
  it('treat no traffic as healthy', () => {
    for (const a of alarms(prod)) {
      expect(a.TreatMissingData).toBe('notBreaching');
    }
  });

  it('carry the conditions aws-services.md §1.12 specifies', () => {
    expect(alarmNamed(prod, 'api-5xx', 'prod')).toMatchObject({
      Threshold: 5,
      Period: 300,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
    expect(alarmNamed(prod, 'api-errors', 'prod')).toMatchObject({
      Threshold: 5,
      Period: 300,
    });
    expect(alarmNamed(prod, 'api-throttles', 'prod')).toMatchObject({
      Threshold: 1,
      Period: 300,
    });
    // A rate over an hour, so evaluated over an hour — not 10,000 in five minutes.
    expect(alarmNamed(prod, 'api-invocations-spike', 'prod')).toMatchObject({
      Threshold: 10_000,
      Period: 3_600,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    // 3 × 5 minutes: a sustained regression, not one slow window behind a cold start.
    expect(alarmNamed(prod, 'api-p95-latency', 'prod')).toMatchObject({
      Threshold: 3_000,
      Period: 300,
      EvaluationPeriods: 3,
      ExtendedStatistic: 'p95',
    });
    expect(alarmNamed(prod, 'ddb-throttles', 'prod')).toMatchObject({ Threshold: 1 });
  });

  it('watch the API function and the table, not a name typed twice', () => {
    const json = JSON.stringify(prod.toJSON());
    expect(json).toContain('AWS/Lambda');
    expect(json).toContain('AWS/ApiGateway');
    expect(json).toContain('AWS/DynamoDB');
    // Cross-stack references arrive as imports, which is what proves they are typed
    // construct props rather than strings assembled here.
    expect(json).toContain('Fn::ImportValue');
  });
});

describe('cost shape', () => {
  /**
   * CloudWatch bills per **alarm metric** beyond the always-free 10 (`cost-model.md`
   * §2.12), and a math-expression alarm is charged per metric it references. Five plain
   * alarms plus a two-metric expression is 7 per stage: inside the allowance for the one
   * stage Phase 4 deploys, and a ~$0.40/month line once Phase 5 adds prod.
   *
   * The number this pins is the one that would move silently: expanding `ddb-throttles` to
   * DynamoDB's nine per-operation metrics would spend nine of the ten free alarm metrics on
   * one alarm and change nothing visible in a diff.
   */
  it('uses 7 alarm metrics per stage', () => {
    const metricAlarms = alarms(prod).filter((a) => a.Metrics === undefined).length;
    const expressionMetrics = alarms(prod)
      .filter((a) => a.Metrics !== undefined)
      // Each math alarm's `Metrics` list holds the expression plus the metrics it reads.
      .reduce((total, a) => total + (a.Metrics?.length ?? 0) - 1, 0);

    expect(metricAlarms).toBe(5);
    expect(expressionMetrics).toBe(2);
    expect(metricAlarms + expressionMetrics).toBe(7);
  });

  /** Every one beyond the always-free 10 is $0.30/month, and none is needed before Phase 8. */
  it('publishes no custom metric', () => {
    prod.resourceCountIs('AWS::CloudWatch::AnomalyDetector', 0);
    const namespaces = JSON.stringify(prod.toJSON()).match(/"Namespace":"[^"]+"/g) ?? [];
    for (const ns of namespaces) {
      expect(ns).toMatch(/"Namespace":"AWS\//);
    }
  });

  /**
   * `cost-model.md` prices this stack from its inventory: CloudWatch §2.12 always free to
   * 10 alarm metrics, 3 dashboards and 1M SNS publishes. An unexpected resource changes
   * that answer, so the inventory is pinned.
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
      'AWS::CloudWatch::Alarm': 6,
      'AWS::CloudWatch::Dashboard': 1,
      'AWS::SNS::Topic': 1,
      'AWS::SNS::TopicPolicy': 1,
      'AWS::SNS::Subscription': 1,
    });
  });
});

describe('the dashboard', () => {
  it('is one per stage, named od-{stage}', () => {
    dev.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: 'od-dev' });
    prod.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'od-prod',
      DashboardBody: Match.anyValue(),
    });
  });

  it('opens with the alarm status, then the graphs behind it', () => {
    const body = JSON.stringify(prod.toJSON()).replace(/\\"/g, '"');
    expect(body).toContain('"type":"alarm"');
    expect(body).toContain('API requests and errors');
    expect(body).toContain('Lambda duration');
    expect(body).toContain('DynamoDB consumed capacity and throttles');
  });
});

describe('the checked-in Log Insights queries', () => {
  const dir = fromWorkspaceRoot('infra', 'observability', 'queries');
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt'));

  it('exist for the common investigations', () => {
    expect(files.sort()).toEqual([
      'errors-by-path.txt',
      'gateway-status-mix.txt',
      'request-volume-by-user.txt',
      'slowest-requests.txt',
      'trace-request.txt',
    ]);
  });

  /**
   * Every query names its log group in the header, because the two log groups have
   * different shapes — the Lambda's is the application's pino line nested under `message`,
   * the gateway's is the flat access-log format. A query run against the wrong one returns
   * an empty result rather than an error, which reads as "nothing is wrong".
   */
  it('each say which log group they are for', () => {
    for (const file of files) {
      const text = readFileSync(`${dir}/${file}`, 'utf8');
      expect(text, file).toMatch(/^# /);
      expect(text.toLowerCase(), file).toContain('log group');
    }
  });

  /** No custom metrics means business counters come from these; they must be queries. */
  it('are queries, not notes', () => {
    for (const file of files) {
      const body = readFileSync(`${dir}/${file}`, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('#') && line.trim() !== '');
      expect(body.length, file).toBeGreaterThan(0);
      expect(body.join('\n'), file).toMatch(/fields|filter|stats/);
    }
  });
});
