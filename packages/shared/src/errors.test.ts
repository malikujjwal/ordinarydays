import { describe, expect, it } from 'vitest';
import { ERROR_CODES, isAppErrorBody } from './errors.js';

describe('ERROR_CODES', () => {
  it('is the closed set from api-contract.md §1 plus tech-stack.md §4.4', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'conflict',
        'forbidden',
        'internal',
        'invite_expired',
        'invite_revoked',
        'not_found',
        'not_implemented',
        'participant_limit_exceeded',
        'payload_too_large',
        'rate_limited',
        'series_limit_exceeded',
        'unauthenticated',
        'upgrade_required',
        'validation_failed',
      ].sort(),
    );
  });

  it('has no duplicates', () => {
    expect(new Set<string>(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe('isAppErrorBody', () => {
  it('accepts a well-formed error envelope', () => {
    expect(
      isAppErrorBody({
        error: { code: 'not_found', message: 'Not found.', requestId: 'req_1' },
      }),
    ).toBe(true);
  });

  it('accepts one carrying details', () => {
    expect(
      isAppErrorBody({
        error: {
          code: 'validation_failed',
          message: 'Invalid.',
          requestId: 'req_1',
          details: [{ path: 'schedule.time', message: 'Expected HH:mm' }],
        },
      }),
    ).toBe(true);
  });

  it.each([
    ['a success envelope', { data: {}, meta: { requestId: 'req_1' } }],
    [
      'a code outside the closed set',
      { error: { code: 'teapot', message: 'x', requestId: 'r' } },
    ],
    ['a missing requestId', { error: { code: 'internal', message: 'x' } }],
    ['null', null],
    ['a string', 'error'],
    ['undefined', undefined],
  ])('rejects %s', (_why, value) => {
    expect(isAppErrorBody(value)).toBe(false);
  });
});
