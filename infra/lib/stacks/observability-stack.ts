import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { applyStackTags } from '../tags.js';
import type { ApiStack } from './api-stack.js';
import type { SchedulerStack } from './scheduler-stack.js';

/**
 * `od-observability-{stage}` — alarms, the alert topic and the dashboard
 * (`infrastructure.md` §1.1).
 *
 * Resources are added by **P0-17**: the `od-alerts-{stage}` SNS topic with an email
 * subscription to `cfg.alertEmail`, the alarms that watch resources Phase 0 writes
 * (`api-5xx`, `api-errors`, `api-throttles`, `api-invocations-spike`, `api-p95-latency`,
 * `ddb-throttles`), and one dashboard. `ses-bounce-rate` and `reminder-errors` arrive with
 * the resources they watch, in Phases 5 and 6.
 *
 * **No custom metrics.** The always-free allowance is 10 and every one beyond costs
 * $0.30/month; business counters come from structured logs via Log Insights.
 *
 * An unconfirmed SNS email subscription means every alarm goes nowhere, silently. Nothing
 * deploys in Phase 0, so nothing can be confirmed — **Phase 4 owns confirming it and firing
 * one alarm deliberately as evidence.**
 */
export interface ObservabilityStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  api: ApiStack;
  scheduler: SchedulerStack;
}

export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'observability', props.cfg.stage);
  }
}
