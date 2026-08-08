import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';

/**
 * The one way an alarm is created in this project (`infrastructure.md` §1, `alarm.ts` —
 * "Alarm + SNS action, one signature").
 *
 * The point of the construct is that **the notification cannot be forgotten**. A
 * `cloudwatch.Alarm` with no action is a coloured square on a page nobody has open; it
 * looks like monitoring in a code review and is worth nothing at 3 a.m. Going through here
 * means the topic is a required argument, so an alarm without one does not compile.
 *
 * Cost: CloudWatch bills **per alarm metric**, and the always-free allowance is 10
 * (`cost-model.md` §2.12). A plain metric alarm is one alarm metric; an alarm on a
 * `MathExpression` is one per metric the expression references, which is why the DynamoDB
 * throttle alarm in `ObservabilityStack` sums two metrics rather than nine.
 */
export interface AlarmProps {
  readonly cfg: EnvConfig;
  /** Short name; the alarm becomes `od-<name>-<stage>`. */
  readonly name: string;
  readonly metric: cloudwatch.IMetric;
  readonly threshold: number;
  /**
   * What is wrong and where to look, in one sentence. It is the body of the email, so it is
   * read by someone with a phone and no laptop — name the Log Insights query that helps.
   */
  readonly description: string;
  readonly topic: sns.ITopic;
  /** Consecutive periods that must breach. Default 1. */
  readonly evaluationPeriods?: number;
  /** Default: `>=`. Use `>` where the doc's condition is a strict ceiling. */
  readonly comparisonOperator?: cloudwatch.ComparisonOperator;
}

export class Alarm extends Construct {
  readonly alarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: AlarmProps) {
    super(scope, id);

    this.alarm = new cloudwatch.Alarm(this, 'Resource', {
      alarmName: `od-${props.name}-${props.cfg.stage}`,
      alarmDescription: props.description,
      metric: props.metric,
      threshold: props.threshold,
      evaluationPeriods: props.evaluationPeriods ?? 1,
      comparisonOperator:
        props.comparisonOperator ??
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      /**
       * **`NOT_BREACHING`, and it has to be.** Every metric here is emitted only when the
       * API is called, and at personal scale most five-minute windows have no traffic at
       * all. The CDK default, `MISSING`, would leave these alarms in `INSUFFICIENT_DATA`
       * most of the night — which reads as "broken" and trains the reader to ignore the
       * mail, the failure mode this whole stack exists to avoid.
       */
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const action = new actions.SnsAction(props.topic);
    this.alarm.addAlarmAction(action);
    /**
     * The recovery mail as well as the breach mail. "Did it stop?" is the immediate next
     * question, and the alternative is refreshing a console tab to find out. SNS's
     * always-free allowance is 1M publishes a month, so the second message is free.
     */
    this.alarm.addOkAction(action);
  }
}
