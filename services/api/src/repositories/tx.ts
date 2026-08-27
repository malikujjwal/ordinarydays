import {
  type CancellationReason,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.js';
import { AppError } from '../lib/errors.js';
import { IdempotencyRaceError } from '../lib/idempotency.js';

/**
 * `TransactWriteItems` composition (`data-model.md` §7).
 *
 * Transactions are used for the write paths in §7 and nowhere else. They are not a default:
 * a transaction costs twice the write units of the same puts and fails the whole batch on
 * one condition, so it is right exactly where "all of these or none" is a correctness
 * requirement — creating an activity with its index entry, moving an index entry between
 * GSI1 buckets — and wrong where it is merely tidy.
 */

/**
 * DynamoDB's hard limit. Exceeding it is a `ValidationException` from the service, which
 * surfaces as a `500` and tells the caller nothing useful — so it is caught here, where the
 * message can name the operation that got too big.
 *
 * The participant cap of 50 does **not** keep every write under this on its own: the
 * RSVP-reset reschedule is 103 items at the cap, which is why P6-15 runs it in two phases
 * rather than one transaction (`data-model.md` §7).
 */
export const MAX_TRANSACT_ITEMS = 100;

/** One item in a transaction, as the SDK wants it. */
type SdkTransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

/**
 * One item in a transaction, **without `TableName`** — {@link transactWrite} stamps it.
 *
 * Omitting it from the input type is the whole point: a call site that had to supply the
 * table name is a call site that can name the wrong one. The SDK's own type marks it
 * required, so accepting that type unchanged would have forced every repository to pass a
 * value this module immediately overwrites.
 *
 * Corrected in P1-09, which was the first production caller and the first thing to fail on
 * it. It went unnoticed in P1-05 because `services/api` excluded test files from `tsc`, so
 * the tests that pass this exact shape were never typechecked — `tsconfig.test.json` now
 * closes that, the same way P1-06 closed it for `packages/shared`.
 */
export type TransactItem = {
  [Verb in keyof SdkTransactItem]?: Omit<NonNullable<SdkTransactItem[Verb]>, 'TableName'>;
};

interface WriteOptions {
  /**
   * Names the operation in the error when the transaction is cancelled, so a `409` says
   * which write lost rather than "a condition failed".
   */
  readonly operation: string;
  /**
   * Maps a cancelled item back to a caller-facing error. The index is the item's position
   * in `items`, so a repository can say "the index entry already existed" rather than
   * leaving the handler to guess which of five items tripped.
   */
  readonly onConditionFailed?: (index: number) => Error | undefined;
}

/**
 * Composes a domain transaction while reserving capacity for middleware-owned receipt and
 * cleanup items. Repositories add their domain items first; the service fills the reserved
 * slots only after it has precomputed the successful HTTP response.
 */
export class TransactionBuilder {
  readonly #items: TransactItem[] = [];
  #reservedFilled = false;

  constructor(
    readonly operation: string,
    readonly reservedSlots = 0,
  ) {
    assertWithinLimit(reservedSlots, operation);
  }

  add(...items: readonly TransactItem[]): this {
    assertWithinLimit(
      this.#items.length + items.length + this.reservedSlots,
      this.operation,
    );
    this.#items.push(...items);
    return this;
  }

  /** Adds the receipt/cleanup items that consumed the capacity reserved at construction. */
  addReserved(...items: readonly TransactItem[]): this {
    if (this.#reservedFilled || items.length !== this.reservedSlots) {
      throw new AppError('internal', 'An unexpected error occurred.', [
        {
          path: this.operation,
          message: `${this.operation} reserved ${this.reservedSlots} transaction slots but supplied ${items.length}.`,
        },
      ]);
    }
    this.#items.push(...items);
    this.#reservedFilled = true;
    return this;
  }

  get length(): number {
    return this.#items.length;
  }

  build(): readonly TransactItem[] {
    if (this.reservedSlots > 0 && !this.#reservedFilled) {
      throw new AppError('internal', 'An unexpected error occurred.', [
        {
          path: this.operation,
          message: `${this.operation} did not supply its ${this.reservedSlots} reserved transaction items.`,
        },
      ]);
    }
    return [...this.#items];
  }
}

/**
 * Runs a transaction, or throws an `AppError` that means something.
 *
 * Every item is stamped with the table name here rather than at each call site: a repository
 * that had to remember `TableName` on every item is a repository where one item eventually
 * goes to the wrong table in a way no type catches.
 */
export async function transactWrite(
  items: readonly TransactItem[],
  options: WriteOptions,
): Promise<void> {
  if (items.length === 0) return;

  assertWithinLimit(items.length, options.operation);

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: items.map((item) => withTableName(item)),
      }),
    );
  } catch (error) {
    throw toAppError(error, options);
  }
}

/**
 * Rejects an oversized transaction **before** it reaches DynamoDB.
 *
 * Exported so a repository composing a fan-out can check as it builds and switch to a
 * batched path — which is what P1-14's delete does for a partition with more than 100 items,
 * and what P6-15 does for the RSVP reset. Failing late, at send time, would mean discovering
 * the limit only for the users who hit it.
 */
export function assertWithinLimit(count: number, operation: string): void {
  if (count > MAX_TRANSACT_ITEMS) {
    throw new AppError(
      'internal',
      // Deliberately the generic message: the caller cannot act on this, and it is a
      // programming error rather than something the user did. The detail is in the log.
      'An unexpected error occurred.',
      [
        {
          path: operation,
          message: `A transaction may hold at most ${MAX_TRANSACT_ITEMS} items; ${operation} built ${count}. Split it into batches.`,
        },
      ],
    );
  }
}

function withTableName(item: TransactItem): SdkTransactItem {
  const [verb, body] = Object.entries(item)[0] as [string, Record<string, unknown>];
  return { [verb]: { ...body, TableName: TABLE_NAME } } as SdkTransactItem;
}

/**
 * Maps `TransactionCanceledException` to the right `AppError`.
 *
 * The SDK reports one reason per item, in order, with `None` for the items that would have
 * succeeded. That positional mapping is the only way to know *which* condition failed, and
 * losing it is why "the transaction was cancelled" is such an unhelpful error in practice.
 */
function toAppError(error: unknown, options: WriteOptions): unknown {
  if (!(error instanceof TransactionCanceledException)) return error;

  const reasons: CancellationReason[] = error.CancellationReasons ?? [];
  const failedIndexes = reasons.flatMap((reason, index) =>
    reason.Code === 'ConditionalCheckFailed' ? [index] : [],
  );

  if (failedIndexes.length > 0) {
    const mapped = failedIndexes.flatMap((index) => {
      const failure = options.onConditionFailed?.(index);
      return failure === undefined ? [] : [failure];
    });
    // A same-key winner can make both a domain condition and the later receipt put fail.
    // The receipt is authoritative in that case: the middleware must replay its exact body
    // instead of surfacing whichever domain conflict DynamoDB happened to list first.
    const receiptRace = mapped.find((failure) => failure instanceof IdempotencyRaceError);
    if (receiptRace !== undefined) return receiptRace;
    if (mapped[0] !== undefined) return mapped[0];
    return new AppError(
      'conflict',
      'This changed while you were editing it. Review the update.',
    );
  }

  // Throughput or a genuine service failure. Not the caller's fault and not retryable by
  // them, so it stays a 500 with the safe message.
  return error;
}
