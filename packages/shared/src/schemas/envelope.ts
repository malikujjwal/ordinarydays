import { z } from 'zod';
import { cursor } from './common.js';

/**
 * The response envelope every endpoint returns (`api-contract.md` §1).
 *
 * Defined once here so the Lambda and the client agree on the wrapper as well as on the
 * payload. A handler that builds `{ data, meta }` by hand is a handler that can forget
 * `requestId`, and the client cannot tell the difference until something needs correlating.
 */
export const responseMeta = z.object({
  requestId: z.string().min(1),
  /** Present only on list responses, and only when there is another page. */
  nextCursor: cursor.optional(),
});

export type ResponseMeta = z.infer<typeof responseMeta>;

/** Wraps a payload schema in the success envelope. */
export function envelope<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: responseMeta });
}
