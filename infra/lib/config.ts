import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { z } from 'zod';

/**
 * The one typed, validated config object. Stacks read `cfg`; they never branch on the
 * environment themselves (`infrastructure.md` §2.2).
 *
 * The stage is selected by **stack name** (`cdk deploy 'od-*-dev'`), never by a `-c stage=`
 * context flag. A context flag is how dev config ends up in a prod stack.
 *
 * Secrets are never in this file. It holds names, sizes and policies — the things that are
 * safe in git and that a reviewer needs to see side by side. There is no `process.env` read
 * here either: what is not in this object is not configuration.
 *
 * This is `infrastructure.md` §2.2 translated to Zod 4, which P0-07 pinned when it closed
 * OQ-11. Every field, value and constraint is unchanged; only the three v3 spellings moved
 * (`z.nativeEnum(X)` → `z.enum(X)`, `z.string().email()` → `z.email()`,
 * `z.string().url()` → `z.url()`). §2.2 is amended to match.
 */
const envConfig = z.object({
  stage: z.enum(['dev', 'prod']),

  // Domain fields are unset until Phase 5 registers the domain. Every stack that consumes
  // one branches once at construction: with `apiDomain` undefined, `ApiStack` skips the
  // custom domain, the certificate and the alias record, and the API is reachable only on
  // its execute-api URL. That branch is what lets all eight stacks synthesise before a
  // domain exists.
  domain: z.string().optional(),
  apiDomain: z.string().optional(),
  mediaDomain: z.string().optional(),

  // Not a lookup — a plain string, so it costs nothing to know before the zone exists.
  // A `HostedZone.fromLookup` on it would need credentials at synth time, which P0-09
  // forbids.
  hostedZoneName: z.string(),

  logRetentionDays: z.enum(logs.RetentionDays),
  apiReservedConcurrency: z.number().int().positive(),
  pointInTimeRecovery: z.boolean(),
  removalPolicy: z.enum(cdk.RemovalPolicy),
  alertEmail: z.email(),
  sesSender: z.email(),
  webOrigins: z.array(z.url()).default([]),
});

export type EnvConfig = z.infer<typeof envConfig>;
export type Stage = EnvConfig['stage'];

export const STAGES = ['dev', 'prod'] as const satisfies readonly Stage[];

/**
 * The GitHub repository allowed to assume the deploy roles, as `owner/repo`.
 *
 * Account-scoped, so it sits outside `EnvConfig`, which is per stage. This value is a
 * **security control**, not a label: it is the `sub` claim condition on the OIDC trust
 * policy, and a wrong or over-broad value decides which repositories on GitHub can assume a
 * role in this account. `infrastructure.md` §3.8 wrote `ujjwal/ordinarydays`; the actual
 * remote is `malikujjwal/ordinarydays`, which is what the trust policy must say.
 */
export const GITHUB_REPO = 'malikujjwal/ordinarydays';

/**
 * The two permanent cost budgets, in whole USD. The first two budgets in an account are
 * free (`cost-model.md` §2.13).
 */
export const BUDGET_USD = { warn: 5, stop: 20 } as const;

/** Dollar impact at which a cost anomaly is worth an email. */
export const ANOMALY_THRESHOLD_USD = 5;

const CONFIG: Record<Stage, EnvConfig> = {
  dev: envConfig.parse({
    stage: 'dev',
    hostedZoneName: 'ordinarydays.app',
    logRetentionDays: logs.RetentionDays.TWO_WEEKS,
    apiReservedConcurrency: 20,
    pointInTimeRecovery: false,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    alertEmail: 'alerts@ordinarydays.app',
    sesSender: 'no-reply@dev.ordinarydays.app',
  }),
  prod: envConfig.parse({
    stage: 'prod',
    hostedZoneName: 'ordinarydays.app',
    logRetentionDays: logs.RetentionDays.ONE_MONTH,
    apiReservedConcurrency: 50,
    pointInTimeRecovery: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    alertEmail: 'alerts@ordinarydays.app',
    sesSender: 'no-reply@ordinarydays.app',
  }),
};

export const getConfig = (stage: Stage): EnvConfig => CONFIG[stage];
