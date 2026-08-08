import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { Alarm } from '../constructs/alarm.js';
import { applyStackTags } from '../tags.js';
import type { ApiStack } from './api-stack.js';
import type { DataStack } from './data-stack.js';
import type { SchedulerStack } from './scheduler-stack.js';

/**
 * `od-observability-{stage}` — alarms, the alert topic and the dashboard
 * (`infrastructure.md` §1.1).
 *
 * Six alarms, from the set in `aws-services.md` §1.12 that watch resources Phase 0 actually
 * writes: `api-5xx`, `api-errors`, `api-throttles`, `api-invocations-spike`,
 * `api-p95-latency` and `ddb-throttles`. `ses-bounce-rate` and `reminder-errors` arrive with
 * the resources they watch, in Phases 5 and 6 — an alarm on a metric no resource emits sits
 * in `INSUFFICIENT_DATA` forever and teaches the reader to ignore the page.
 *
 * **No custom metrics.** The always-free allowance is 10 and each one beyond costs
 * $0.30/month (`cost-model.md` §2.12); business counters come from the structured logs via
 * the Log Insights queries in `infra/observability/queries/`. Everything alarmed here is an
 * AWS-published metric.
 *
 * **Nothing here is deployed in Phase 0, so the SNS subscription is not confirmed.** An
 * unconfirmed email subscription means every alarm in this stack goes nowhere, silently and
 * with no error anywhere — the stack deploys clean and the mail never arrives. **Phase 4
 * owns confirming the subscription and deliberately firing one alarm as evidence** that the
 * whole path works. Do not assume that has happened because this file exists.
 *
 * Free-tier buckets (`cost-model.md` §2.12): CloudWatch bills per **alarm metric** beyond
 * the always-free 10, at ~$0.10 each. This stack is 7 per stage — five plain metric alarms
 * plus `ddb-throttles`, whose math expression references two metrics. One deployed stage
 * (Phase 4, dev only) is inside the allowance; both stages (Phase 5) is 14 and costs about
 * $0.40/month, which is a Phase 5 number to carry rather than a Phase 0 one, since nothing
 * here deploys yet. Dashboards are free to three per account and this is one per stage. SNS
 * publishes are always free to 1M/month. Nothing carries an hourly charge.
 */
export interface ObservabilityStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  api: ApiStack;
  /**
   * Added in P0-17. `ddb-throttles` watches the table, and a stateful resource is never
   * referenced by name-string across stacks (`infrastructure.md` §1.2) — so the table
   * arrives as a typed construct like every other cross-stack reference. §1.2's snippet is
   * amended to match.
   */
  data: DataStack;
  /** Unused until Phase 6 adds `reminder-errors` over the reminder Lambda. */
  scheduler: SchedulerStack;
}

/** Alarm evaluation and dashboard resolution. Five minutes is the CloudWatch default. */
const PERIOD = Duration.minutes(5);

export class ObservabilityStack extends cdk.Stack {
  readonly topic: sns.Topic;
  readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'observability', props.cfg.stage);

    this.topic = this.createAlertTopic(props.cfg);

    const metrics = this.watchedMetrics(props);
    this.alarms = this.createAlarms(props.cfg, metrics);
    this.createDashboard(props.cfg, metrics);
  }

  /**
   * `od-alerts-{stage}` — the one destination for every alarm in the environment.
   *
   * One topic, not one per severity: at this scale a second topic is a second subscription
   * to confirm and a second place for a notification to be silently lost.
   */
  private createAlertTopic(cfg: EnvConfig): sns.Topic {
    const topic = new sns.Topic(this, 'Alerts', {
      topicName: `od-alerts-${cfg.stage}`,
      displayName: `Ordinary Days ${cfg.stage} alerts`,
      // Denies every publish that does not arrive over TLS. Alarm actions are in-account
      // and already use TLS; this closes the case where something else is given publish.
      enforceSSL: true,
    });

    /**
     * The subscription is created `PendingConfirmation` and stays that way until the
     * address owner clicks the link in the confirmation email. CloudFormation reports the
     * stack as complete either way, which is exactly why P0-17 cannot prove this works and
     * Phase 4 must.
     */
    topic.addSubscription(new subscriptions.EmailSubscription(cfg.alertEmail));

    return topic;
  }

  /**
   * The metrics the alarms and the dashboard share, so a threshold and the graph beside it
   * can never end up describing different things.
   *
   * Lambda metrics come from the **function**, not the `live` alias. The function-level
   * metric aggregates every invocation whatever routed it; the alias-level one would miss a
   * direct invocation or a version invoked during a rollback — the moments most worth
   * seeing.
   */
  private watchedMetrics({ api, data }: ObservabilityStackProps): WatchedMetrics {
    /**
     * DynamoDB's `ThrottledRequests` is only published with an `Operation` dimension, which
     * is why CDK deprecated `metricThrottledRequests()` as "an invalid metric". The
     * per-operation alternative is a math expression over nine operations, and CloudWatch
     * bills a math alarm **per referenced metric** — nine of the ten always-free alarm
     * metrics, for one alarm. `ReadThrottleEvents + WriteThrottleEvents` is the same signal
     * for a table, at two. `aws-services.md` §1.12 is amended to say so.
     */
    const ddbThrottles = new cloudwatch.MathExpression({
      expression: 'reads + writes',
      usingMetrics: {
        reads: data.table.metric('ReadThrottleEvents', {
          period: PERIOD,
          statistic: 'Sum',
        }),
        writes: data.table.metric('WriteThrottleEvents', {
          period: PERIOD,
          statistic: 'Sum',
        }),
      },
      label: 'Throttled requests',
      period: PERIOD,
    });

    return {
      requests: api.httpApi.metricCount({ period: PERIOD, statistic: 'Sum' }),
      clientErrors: api.httpApi.metricClientError({ period: PERIOD, statistic: 'Sum' }),
      serverErrors: api.httpApi.metricServerError({ period: PERIOD, statistic: 'Sum' }),
      invocations: api.fn.metricInvocations({ period: PERIOD, statistic: 'Sum' }),
      errors: api.fn.metricErrors({ period: PERIOD, statistic: 'Sum' }),
      throttles: api.fn.metricThrottles({ period: PERIOD, statistic: 'Sum' }),
      duration: api.fn.metricDuration({ period: PERIOD, statistic: 'p95' }),
      readCapacity: data.table.metricConsumedReadCapacityUnits({ period: PERIOD }),
      writeCapacity: data.table.metricConsumedWriteCapacityUnits({ period: PERIOD }),
      ddbThrottles,
    };
  }

  /** The six alarms, each with its condition from `aws-services.md` §1.12. */
  private createAlarms(cfg: EnvConfig, m: WatchedMetrics): cloudwatch.Alarm[] {
    const alarm = (
      id: string,
      name: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      description: string,
      options: {
        evaluationPeriods?: number;
        comparisonOperator?: cloudwatch.ComparisonOperator;
      } = {},
    ): cloudwatch.Alarm =>
      new Alarm(this, id, {
        cfg,
        name,
        metric,
        threshold,
        description,
        topic: this.topic,
        ...options,
      }).alarm;

    return [
      alarm(
        'Api5xx',
        'api-5xx',
        m.serverErrors,
        5,
        'API Gateway returned 5xx responses. Run queries/errors-by-path.txt against the API log group.',
      ),
      alarm(
        'ApiErrors',
        'api-errors',
        m.errors,
        5,
        'The API Lambda is failing. Same incident as api-5xx seen from the other side; if only this one fired, the failure is after the response was sent.',
      ),
      // One is enough: reserved concurrency is a hard ceiling, so a single throttle is a
      // request that got 429 rather than an answer. It means an attack or a real spike.
      alarm(
        'ApiThrottles',
        'api-throttles',
        m.throttles,
        1,
        'The API Lambda hit its reserved concurrency. Check queries/request-volume-by-user.txt before raising the limit.',
      ),
      /**
       * The cost guardrail (`cost-model.md` §5.8), and the only alarm here whose period is
       * not five minutes: it is a rate over an hour, so it is evaluated over an hour.
       * Nothing legitimate produces 10,000 invocations in one at this scale.
       */
      alarm(
        'ApiInvocationsSpike',
        'api-invocations-spike',
        m.invocations.with({ period: Duration.hours(1) }),
        10_000,
        'Over 10,000 API invocations in an hour — a retry loop or a scraper, before it becomes a bill. Run queries/request-volume-by-user.txt.',
        { comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD },
      ),
      // Three consecutive five-minute periods, so "p95 over 3 s for 15 minutes" is a
      // regression rather than one slow window behind a cold start.
      alarm(
        'ApiP95Latency',
        'api-p95-latency',
        m.duration,
        3_000,
        'API p95 duration above 3s for 15 minutes. Run queries/slowest-requests.txt to find which paths.',
        {
          evaluationPeriods: 3,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        },
      ),
      // Should be impossible on an on-demand table. If it fires, it is a hot partition —
      // a key design problem, not a capacity one, and no threshold change will fix it.
      alarm(
        'DdbThrottles',
        'ddb-throttles',
        m.ddbThrottles,
        1,
        'DynamoDB throttled a request. On an on-demand table this means a hot partition: check the key design for the access pattern in play, not the capacity.',
      ),
    ];
  }

  /**
   * One dashboard per stage, `od-{stage}`.
   *
   * Free: CloudWatch allows three dashboards per account at no charge and this is one of
   * two. Every metric on it is already alarmed or is context for one, in the order the
   * questions get asked — is it up, is it failing, is it slow, is the table healthy.
   */
  private createDashboard(cfg: EnvConfig, m: WatchedMetrics): void {
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `od-${cfg.stage}`,
      defaultInterval: Duration.hours(12),
    });

    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: `Alarms · ${cfg.stage}`,
        alarms: this.alarms,
        width: 24,
        height: 3,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API requests and errors',
        left: [m.requests, m.clientErrors, m.serverErrors],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda invocations, errors and throttles',
        left: [m.invocations, m.errors, m.throttles],
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda duration',
        left: [
          m.duration.with({ statistic: 'p50', label: 'p50' }),
          m.duration.with({ label: 'p95' }),
          m.duration.with({ statistic: 'Maximum', label: 'max' }),
        ],
        leftYAxis: { label: 'ms', showUnits: false },
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB consumed capacity and throttles',
        left: [m.readCapacity, m.writeCapacity],
        right: [m.ddbThrottles],
        width: 12,
      }),
    );
  }
}

interface WatchedMetrics {
  readonly requests: cloudwatch.Metric;
  readonly clientErrors: cloudwatch.Metric;
  readonly serverErrors: cloudwatch.Metric;
  readonly invocations: cloudwatch.Metric;
  readonly errors: cloudwatch.Metric;
  readonly throttles: cloudwatch.Metric;
  /** p95, which is what `api-p95-latency` alarms on; the dashboard re-reads it at p50/max. */
  readonly duration: cloudwatch.Metric;
  readonly readCapacity: cloudwatch.Metric;
  readonly writeCapacity: cloudwatch.Metric;
  readonly ddbThrottles: cloudwatch.MathExpression;
}
