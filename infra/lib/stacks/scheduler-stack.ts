import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';
import { applyStackTags } from '../tags.js';
import type { ApiStack } from './api-stack.js';
import type { DataStack } from './data-stack.js';

/**
 * `od-scheduler-{stage}` — EventBridge Scheduler and the reminder Lambda
 * (`infrastructure.md` §1.1).
 *
 * Stays an empty shell through **P0-18**. It gains the schedule group, the reminder Lambda
 * and its role, the scheduler-invocation role the API assumes to create one-shot schedules,
 * and the daily maintenance rule in **Phase 6**, alongside the notifications that need them.
 *
 * Takes `api` because the API's execution role must be able to create schedules in this
 * stack's group, and `data` because the reminder Lambda reads the table.
 */
export interface SchedulerStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  data: DataStack;
  api: ApiStack;
}

export class SchedulerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);
    applyStackTags(this, 'scheduler', props.cfg.stage);
  }
}
