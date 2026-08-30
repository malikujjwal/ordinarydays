import { ApiError } from '@od/shared/client';
import { describe, expect, it, vi } from 'vitest';
import { describeAddFailure } from './useAddListItem';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-add-test' }));

describe('describeAddFailure', () => {
  it('keeps the request id beside contracted 5xx copy', () => {
    expect(
      describeAddFailure(new ApiError('internal', 'Database exploded', 500, 'req_add_9')),
    ).toEqual({ message: 'Something went wrong.', requestId: 'req_add_9' });
  });

  it('keeps the server sentence and request id for a user-facing 4xx', () => {
    expect(
      describeAddFailure(
        new ApiError('validation_failed', 'A title is required.', 400, 'req_add_10'),
      ),
    ).toEqual({ message: 'A title is required.', requestId: 'req_add_10' });
  });

  it('does not invent a request id for a local failure', () => {
    expect(describeAddFailure(new Error('offline'))).toEqual({
      message: "Couldn't save this.",
    });
  });
});
