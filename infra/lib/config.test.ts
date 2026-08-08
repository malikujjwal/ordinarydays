import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';
import { getConfig, STAGES } from './config.js';

describe('getConfig', () => {
  it('parses every stage at module load, so a bad value fails before synth', () => {
    for (const stage of STAGES) {
      expect(getConfig(stage).stage).toBe(stage);
    }
  });

  // The four fields that decide what survives a mistake. If dev and prod ever agree on
  // these, either dev has become expensive to run or prod has become easy to destroy.
  it('separates prod from dev on the fields that control blast radius', () => {
    const dev = getConfig('dev');
    const prod = getConfig('prod');

    expect(prod.removalPolicy).toBe(cdk.RemovalPolicy.RETAIN);
    expect(dev.removalPolicy).toBe(cdk.RemovalPolicy.DESTROY);

    expect(prod.pointInTimeRecovery).toBe(true);
    expect(dev.pointInTimeRecovery).toBe(false);

    expect(prod.logRetentionDays).toBe(logs.RetentionDays.ONE_MONTH);
    expect(dev.logRetentionDays).toBe(logs.RetentionDays.TWO_WEEKS);

    expect(prod.apiReservedConcurrency).toBe(50);
    expect(dev.apiReservedConcurrency).toBe(20);
  });

  // Phase 5 registers the domain. Until then every stack that consumes one of these
  // branches once at construction and skips the certificate, the custom domain and the
  // alias record — which is what lets all eight stacks synthesise with no domain.
  it.each(STAGES)('leaves every domain field unset in %s', (stage) => {
    const cfg = getConfig(stage);
    expect(cfg.domain).toBeUndefined();
    expect(cfg.apiDomain).toBeUndefined();
    expect(cfg.mediaDomain).toBeUndefined();
    expect(cfg.webOrigins).toEqual([]);
  });

  // A plain string, not a lookup. `HostedZone.fromLookup` would need credentials at synth
  // time, which P0-09 forbids outright.
  it.each(STAGES)('knows the hosted zone name in %s without looking it up', (stage) => {
    expect(getConfig(stage).hostedZoneName).toBe('ordinarydays.app');
  });

  it('holds no secret — only names, sizes and policies', () => {
    const serialised = JSON.stringify(STAGES.map(getConfig));
    for (const smell of ['password', 'secret', 'token', 'AKIA', 'PRIVATE KEY']) {
      expect(serialised.toLowerCase()).not.toContain(smell.toLowerCase());
    }
  });
});
