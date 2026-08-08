import { describe, expect, expectTypeOf, it } from 'vitest';
import { type AppErrorBody, ERROR_CODES, isAppErrorBody } from '../errors.js';
import { type ErrorResponse, errorResponse } from './error.js';

/**
 * The schema and the `AppErrorBody` interface describe one wire shape. Nothing forces them
 * to agree, so this file does — in both directions, because a one-way assertion passes
 * happily when one side gains a field the other lacks.
 */
describe('the schema and the interface are the same shape', () => {
  it('is assignable both ways', () => {
    expectTypeOf<ErrorResponse>().toEqualTypeOf<AppErrorBody>();
  });
});

describe('what the schema accepts', () => {
  const valid: ErrorResponse = {
    error: {
      code: 'not_found',
      message: 'This isn’t here any more.',
      requestId: 'req_1',
    },
  };

  it('accepts the minimal envelope', () => {
    expect(errorResponse.safeParse(valid).success).toBe(true);
  });

  it('accepts validation details', () => {
    const withDetails: ErrorResponse = {
      error: {
        code: 'validation_failed',
        message: 'Bad.',
        details: [{ path: 'schedule.time', message: 'Expected HH:mm' }],
        requestId: 'req_1',
      },
    };

    expect(errorResponse.safeParse(withDetails).success).toBe(true);
  });

  it.each(ERROR_CODES)('accepts %s, so the closed union has one home', (code) => {
    expect(errorResponse.safeParse({ error: { ...valid.error, code } }).success).toBe(
      true,
    );
  });

  it('rejects a code outside the union', () => {
    expect(
      errorResponse.safeParse({ error: { ...valid.error, code: 'teapot' } }).success,
    ).toBe(false);
  });

  it('rejects a missing requestId, which is what makes an error traceable', () => {
    expect(
      errorResponse.safeParse({ error: { code: 'internal', message: 'x' } }).success,
    ).toBe(false);
  });
});

/**
 * `isAppErrorBody` is the client's runtime narrowing check and the schema is the published
 * contract. If they disagreed, the client would reject a body the spec says is valid — so
 * they are checked against the same inputs.
 */
describe('the schema agrees with the client’s narrowing check', () => {
  it.each([
    [
      'a minimal envelope',
      { error: { code: 'not_found', message: 'x', requestId: 'r' } },
      true,
    ],
    [
      'an unknown code',
      { error: { code: 'teapot', message: 'x', requestId: 'r' } },
      false,
    ],
    ['a missing requestId', { error: { code: 'internal', message: 'x' } }, false],
    ['a null body', null, false],
    ['a body with no error key', { data: {} }, false],
  ])('agrees on %s', (_name, body, expected) => {
    expect(errorResponse.safeParse(body).success).toBe(expected);
    expect(isAppErrorBody(body)).toBe(expected);
  });
});
