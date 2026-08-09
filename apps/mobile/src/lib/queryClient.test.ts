import { ApiError, NetworkError } from '@od/shared/client';
import { describe, expect, it } from 'vitest';
import { queryClient } from '@/lib/queryClient';

/**
 * The defaults from `tech-stack.md` §3.4, asserted rather than assumed.
 *
 * The retry predicate is the one with teeth: the library default retries **everything**
 * three times, so before `isRetryable` existed a `validation_failed` — which fails
 * identically forever — cost four round trips and delayed the error the user needs to see by
 * several seconds.
 */
const queries = queryClient.getDefaultOptions().queries;

/** The predicate as TanStack Query will call it. */
const willRetry = (failureCount: number, error: unknown): boolean => {
  const retry = queries?.retry;
  return typeof retry === 'function' ? retry(failureCount, error as Error) : false;
};

describe('the query client defaults', () => {
  it('is offlineFirst, so a cached screen renders on a subway instead of spinning', () => {
    expect(queries?.networkMode).toBe('offlineFirst');
  });

  it('keeps a week of history and a minute of freshness', () => {
    expect(queries?.staleTime).toBe(60_000);
    expect(queries?.gcTime).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('the retry predicate', () => {
  it('retries a transport failure', () => {
    expect(willRetry(0, new NetworkError('offline', undefined))).toBe(true);
  });

  it('retries a 5xx, which may well succeed on the next attempt', () => {
    expect(willRetry(0, new ApiError('internal', 'x', 500, 'req_a'))).toBe(true);
  });

  it.each([
    ['a validation failure, which fails identically forever', 'validation_failed', 400],
    ['a 404, because the row will not appear by asking again', 'not_found', 404],
    ['a 429 — the server has already said to slow down', 'rate_limited', 429],
  ] as const)('does not retry %s', (_why, code, status) => {
    expect(willRetry(0, new ApiError(code, 'x', status, 'req_a'))).toBe(false);
  });

  it('gives up after three attempts even on a retryable error', () => {
    const error = new NetworkError('offline', undefined);
    expect(willRetry(2, error)).toBe(true);
    expect(willRetry(3, error)).toBe(false);
  });
});
