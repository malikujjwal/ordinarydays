import * as cdk from 'aws-cdk-lib';
import type { Stage } from './config.js';

/**
 * The five tags from `infrastructure.md` §2.4, split by the scope they actually have.
 *
 * §2.4 says all five are applied at the app level. Three of them can be: `Project`,
 * `ManagedBy` and `Owner` are the same for every resource in the account. `Stage` and
 * `Component` cannot — they vary per stack, which is the entire reason Cost Explorer is
 * grouped by them. So the app carries the constants and each stack carries its own two.
 *
 * Activate `Stage`, `Component` and `Project` as **cost allocation tags** in the Billing
 * console after the first deploy. They are not retroactive: they only appear in cost
 * reports from the day they are activated.
 */

/**
 * `account` is not in §2.4's list of `Component` values, because that list was written for
 * the seven per-stage stacks. `AccountStack` is an account-scoped singleton and still needs
 * to be attributable in a cost report, so it takes its own value. §2.4 is amended to match.
 */
export type Component =
  | 'account'
  | 'dns'
  | 'auth'
  | 'data'
  | 'api'
  | 'web'
  | 'scheduler'
  | 'observability';

/** Applied once to the app, in `bin/ordinarydays.ts`. Inherited by every taggable resource. */
export function applyAppTags(app: cdk.App): void {
  cdk.Tags.of(app).add('Project', 'ordinarydays');
  cdk.Tags.of(app).add('ManagedBy', 'cdk');
  cdk.Tags.of(app).add('Owner', 'ujjwal');
}

/** Applied by each stack's constructor. `AccountStack` passes no stage — it has none. */
export function applyStackTags(
  stack: cdk.Stack,
  component: Component,
  stage?: Stage,
): void {
  cdk.Tags.of(stack).add('Component', component);
  if (stage) cdk.Tags.of(stack).add('Stage', stage);
}
