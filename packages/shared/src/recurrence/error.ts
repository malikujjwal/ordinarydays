import type { ErrorCode } from '../errors.js';

/** A caller-safe recurrence rule failure using the API's closed validation code. */
export class RecurrenceValidationError extends Error {
  readonly code = 'validation_failed' satisfies ErrorCode;

  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceValidationError';
  }
}
