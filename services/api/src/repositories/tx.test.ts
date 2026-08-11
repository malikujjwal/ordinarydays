import { describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors.js';
import { assertWithinLimit, MAX_TRANSACT_ITEMS, TransactionBuilder } from './tx.js';

/**
 * The limit check is unit-tested here; the send path is exercised against DynamoDB Local in
 * `test/integration/repository-base.int.test.ts`, where a real conditional failure can be
 * provoked rather than mocked into existence.
 */
describe('the transaction item cap', () => {
  it(`is DynamoDB's ${MAX_TRANSACT_ITEMS}`, () => {
    expect(MAX_TRANSACT_ITEMS).toBe(100);
  });

  it('accepts a transaction at exactly the limit', () => {
    expect(() => assertWithinLimit(MAX_TRANSACT_ITEMS, 'createActivity')).not.toThrow();
  });

  it('rejects the 101st item', () => {
    expect(() => assertWithinLimit(MAX_TRANSACT_ITEMS + 1, 'createActivity')).toThrow(
      AppError,
    );
  });

  /**
   * The caller cannot act on this and the user did not cause it — it is a programming error
   * in the code that composed the transaction. So the envelope carries the safe message and
   * the detail that names the operation and the count goes where an engineer will read it.
   */
  it('surfaces as internal with the safe message, and names the operation in the detail', () => {
    try {
      assertWithinLimit(103, 'rescheduleWithRsvpReset');
      expect.unreachable('should have thrown');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe('internal');
      expect(appError.message).toBe('An unexpected error occurred.');
      expect(appError.details?.[0]?.path).toBe('rescheduleWithRsvpReset');
      expect(appError.details?.[0]?.message).toContain('103');
    }
  });

  /**
   * The RSVP-reset reschedule is 103 items at the 50-participant cap, which is why P6-15
   * runs it in two phases. Checking as a composition is built — rather than at send time —
   * is what lets a repository switch to the batched path instead of discovering the limit
   * only for the users who hit it.
   */
  it('is checkable before send, so a fan-out can switch to batching', () => {
    expect(() => assertWithinLimit(103, 'rescheduleWithRsvpReset')).toThrow();
    expect(() => assertWithinLimit(45 * 2 + 3, 'rescheduleWithRsvpReset')).not.toThrow();
  });
});

describe('reserved receipt capacity', () => {
  it('rejects a 100th domain item when one receipt slot is reserved', () => {
    const builder = new TransactionBuilder('singlePhase', 1);
    expect(() =>
      builder.add(...Array.from({ length: 100 }, () => ({ Put: { Item: {} } }))),
    ).toThrow(AppError);
  });

  it('accepts 99 domain items plus the one reserved receipt', () => {
    const builder = new TransactionBuilder('singlePhase', 1);
    builder.add(...Array.from({ length: 99 }, () => ({ Put: { Item: {} } })));
    builder.addReserved({ Put: { Item: { entity: 'Idempotency' } } });
    expect(builder.build()).toHaveLength(100);
  });

  it('requires both reserved items for a multi-phase mutation', () => {
    const builder = new TransactionBuilder('multiPhase', 2).add({ Put: { Item: {} } });
    expect(() => builder.addReserved({ Put: { Item: {} } })).toThrow(AppError);
  });
});
