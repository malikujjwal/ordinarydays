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
 * A shell, and P0-18 leaves it one. It gains the `od-reminders-{stage}` schedule group, the
 * reminder Lambda and its role, and the scheduler-invocation role the API assumes to create
 * one-shot schedules, in **P5-12/P5-13** — alongside the push notifications that are the
 * only reason any of it exists. The daily maintenance rule arrives later still, with the
 * 30-day purge job it runs (**P5-22**).
 *
 * > **Corrected in P0-18: this said Phase 6.** `SchedulerStack` is Phase **5** — the
 * > roadmap's §1.6 and §3.1 both put it there and P5-12 owns the file. A shell that names
 * > the wrong phase is worse than no shell, because the next agent reads it instead of the
 * > roadmap.
 *
 * Not in Phase 4's dev deploy set (**P4-05**): `bin/ordinarydays.ts` instantiates only the
 * five stacks that phase deploys. This one keeps synthesising, and its assertion test keeps
 * running, so it cannot rot while it waits.
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
