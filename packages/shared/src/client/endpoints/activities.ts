import { activity, type CreateActivityInput } from '../../schemas/activity.js';
import { envelope } from '../../schemas/envelope.js';
import type { Activity } from '../../types/activity.js';
import type { HttpClient } from '../http.js';

/**
 * The Activity endpoint functions (`api-contract.md` §2.3).
 *
 * ## Why the input type is `CreateActivityInput` and not a looser shape
 *
 * `CreateActivityInput` is a discriminated union on `objectKind`, so **the type system will
 * not let a caller build a request without a complete, valid target pair**. There is no
 * `Partial<>`, no `type?:` and no builder that fills a default — a form store that has not
 * yet been given a target simply cannot produce a value of this type, which is the compile-
 * time half of `CLAUDE.md` rule 2. The runtime half is the schema on the server.
 *
 * Do not add an overload, a default parameter, or a helper that supplies `objectKind` or
 * `type`. The one place either is chosen is the user's tap on the chooser.
 */

export const activityResponse = envelope(activity);

/**
 * `POST /v1/activities`.
 *
 * `idempotencyKey` is **required**, not optional. Every creating `POST` carries one
 * (`api-contract.md` §1), and it is also what makes the request retryable at all — the
 * client's retry predicate looks for exactly this header. An optional parameter here would
 * mean a create that silently loses its retries and can double-write on a flaky connection.
 * The caller generates it once at `onMutate` and reuses it across retries.
 */
export function createActivity(
  client: HttpClient,
  input: CreateActivityInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Activity> {
  return client
    .request({
      method: 'POST',
      path: '/v1/activities',
      schema: activityResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as Activity);
}
