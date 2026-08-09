import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  consume,
  hashSubject,
  type RateLimitRule,
  windowStartSeconds,
} from './rateLimitRepository.js';

/**
 * **Did we build the right command?** — the question a mock answers and a database cannot
 * (`testing.md` §4.2). A counter that incremented without its condition would still return
 * success; it would simply never refuse anything.
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

const GENERAL: RateLimitRule = { scope: 'general', limit: 120, windowSeconds: 60 };

/** 2026-08-09T00:00:30Z — thirty seconds into a minute window. */
const MID_WINDOW = Date.UTC(2026, 7, 9, 0, 0, 30);

const conditionalFailure = () => {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
};

const sentUpdate = () => ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;

beforeEach(() => {
  ddbMock.reset();
});

describe('the window', () => {
  it('floors to the window size, so every request in a minute shares one counter', () => {
    expect(windowStartSeconds(MID_WINDOW, 60)).toBe(Date.UTC(2026, 7, 9, 0, 0, 0) / 1000);
  });

  it('puts the last millisecond of a window in that window, not the next', () => {
    const lastMs = Date.UTC(2026, 7, 9, 0, 0, 59, 999);
    expect(windowStartSeconds(lastMs, 60)).toBe(Date.UTC(2026, 7, 9, 0, 0, 0) / 1000);
  });

  it('starts a new window on the boundary', () => {
    const boundary = Date.UTC(2026, 7, 9, 0, 1, 0);
    expect(windowStartSeconds(boundary, 60)).toBe(Date.UTC(2026, 7, 9, 0, 1, 0) / 1000);
  });

  it('floors an hourly window to the hour', () => {
    expect(windowStartSeconds(MID_WINDOW, 3600)).toBe(
      Date.UTC(2026, 7, 9, 0, 0, 0) / 1000,
    );
  });
});

describe('the counter write', () => {
  it('increments atomically under a condition, rather than reading then deciding', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await consume(GENERAL, 'usr_local_dev', MID_WINDOW);

    const input = sentUpdate();
    expect(input?.UpdateExpression).toBe('SET #ttl = :ttl ADD #n :one');
    /**
     * `attribute_not_exists` is what makes the first request in a window pass: `ADD` starts
     * a missing counter at zero, and a bare `#n < :limit` would fail the condition before
     * the attribute existed — refusing every first request of every window.
     */
    expect(input?.ConditionExpression).toBe('attribute_not_exists(#n) OR #n < :limit');
    expect(input?.ExpressionAttributeValues).toMatchObject({ ':one': 1, ':limit': 120 });
  });

  it('keys on the scope, the subject and the window start', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await consume(GENERAL, 'usr_local_dev', MID_WINDOW);

    expect(sentUpdate()?.Key).toEqual({
      pk: 'RATE#general#usr_local_dev',
      sk: String(Date.UTC(2026, 7, 9, 0, 0, 0) / 1000),
    });
  });

  /** The counter deletes itself when the window ends, at no cost (`data-model.md` §3.4). */
  it('sets ttl to the window end', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await consume(GENERAL, 'usr_local_dev', MID_WINDOW);

    expect(sentUpdate()?.ExpressionAttributeValues?.[':ttl']).toBe(
      Date.UTC(2026, 7, 9, 0, 1, 0) / 1000,
    );
  });

  /**
   * Scopes exist so an hourly capture allowance and the general per-minute one never share a
   * counter — which they would if the key were `RATE#<subject>` alone.
   */
  it('gives each scope its own partition for the same subject', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await consume(GENERAL, 'usr_a', MID_WINDOW);
    await consume(
      { scope: 'capture', limit: 20, windowSeconds: 3600 },
      'usr_a',
      MID_WINDOW,
    );

    const keys = ddbMock
      .commandCalls(UpdateCommand)
      .map((call) => call.args[0].input.Key);
    expect(keys[0]?.pk).toBe('RATE#general#usr_a');
    expect(keys[1]?.pk).toBe('RATE#capture#usr_a');
  });
});

describe('the outcome', () => {
  it('allows a request under the limit', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await expect(consume(GENERAL, 'usr_a', MID_WINDOW)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 30,
      degraded: false,
    });
  });

  /** Over the limit arrives as an exception, because the check is a condition. */
  it('refuses when the condition fails, with the seconds left in the window', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());

    await expect(consume(GENERAL, 'usr_a', MID_WINDOW)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 30,
      degraded: false,
    });
  });

  it('never reports Retry-After as zero on the last millisecond of a window', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());

    const outcome = await consume(GENERAL, 'usr_a', Date.UTC(2026, 7, 9, 0, 0, 59, 999));
    expect(outcome.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  /**
   * A limiter that takes the API down is worse than one that occasionally lets a request
   * through (P1-03). Note this is `allowed: true` **and** `degraded: true` — the caller
   * proceeds and logs.
   */
  it('allows the request and flags itself degraded when DynamoDB fails', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new Error('ProvisionedThroughputExceededException'));

    await expect(consume(GENERAL, 'usr_a', MID_WINDOW)).resolves.toMatchObject({
      allowed: true,
      degraded: true,
    });
  });

  it('does not confuse a throttle with the limit', async () => {
    const throttle = new Error('throttled');
    throttle.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(UpdateCommand).rejects(throttle);

    const outcome = await consume(GENERAL, 'usr_a', MID_WINDOW);
    expect(outcome.allowed).toBe(true);
    expect(outcome.degraded).toBe(true);
  });
});

describe('hashSubject', () => {
  it('is a hex SHA-256 that does not contain the input', () => {
    const digest = hashSubject('203.0.113.7', 'a-salt');

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('203.0.113');
  });

  it('is stable for the same input and salt', () => {
    expect(hashSubject('203.0.113.7', 's')).toBe(hashSubject('203.0.113.7', 's'));
  });

  it('differs per address and per salt', () => {
    expect(hashSubject('203.0.113.7', 's')).not.toBe(hashSubject('203.0.113.8', 's'));
    expect(hashSubject('203.0.113.7', 's')).not.toBe(hashSubject('203.0.113.7', 't'));
  });

  /**
   * The parameter is required and there is deliberately no `salt = ''` default: an unsalted
   * SHA-256 of an IPv4 address is reversible over a 2^32 space, so the digest *is* the
   * address. Refusing an empty salt is what stops that shipping by omission.
   */
  it('refuses an empty salt rather than hashing without one', () => {
    expect(() => hashSubject('203.0.113.7', '')).toThrowError(/non-empty salt/);
  });
});
