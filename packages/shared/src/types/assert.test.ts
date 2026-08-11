import { describe, expect, it } from 'vitest';
import { assertNever } from './assert.js';

describe('assertNever', () => {
  it('names the exhaustive value in its default error', () => {
    expect(() => assertNever('future' as never, 'Frequency')).toThrow(
      'Unhandled Frequency: future',
    );
  });

  it('uses a domain error factory when the boundary has a public error type', () => {
    class DomainError extends Error {}

    expect(() =>
      assertNever(
        'future' as never,
        'Frequency',
        (value) => new DomainError(`Unsupported ${value}`),
      ),
    ).toThrow(DomainError);
  });
});
