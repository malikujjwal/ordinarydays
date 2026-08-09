import type { CreateActivityInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { createActivity } from '../services/activityService.js';

/**
 * `POST /v1/activities` (`api-contract.md` §2.3).
 *
 * ## The handler makes no decisions, and that is the point
 *
 * By the time this runs, validation has required a complete, valid `objectKind`/`type` pair —
 * the one the user chose in the global chooser or that a labelled contextual action fixed.
 * There is **no default, no classification branch and no recovery path here**: a body without
 * a complete pair never reaches this line, because `createActivityInput` is a discriminated
 * union and the route's validator throws on a failure (`CLAUDE.md` rule 2).
 *
 * So the shape is three lines: validated input in, one service call, `201` with the created
 * activity in the envelope. Everything a reader might look for in a create handler — status
 * derivation, the instant, visibility, the nesting cap, the participants refusal — is in
 * `activityService` (P1-10), because a rule in a handler is a rule the next endpoint
 * re-derives slightly differently.
 *
 * ## Why the response echoes the target back
 *
 * `data.objectKind` and `data.type` are both in the response so the client can verify it
 * saved the target the user selected, rather than trusting that it did. That is a cheap
 * check against the failure mode the whole explicit-intent contract exists to prevent.
 *
 * The registry entry carries `creates`, so `idempotency` (chain position 10) requires an
 * `Idempotency-Key` and replays the stored response on a retry — which matters here more
 * than on most creates: mobile networks retry, and without the key a timed-out request that
 * actually succeeded leaves the user with two identical activities and no way to tell which
 * one their reminder is on.
 */
export async function createActivityHandler(
  c: Context<AppEnv>,
  input: CreateActivityInput,
  now: string,
): Promise<Response> {
  const { activity } = await createActivity(requireUserId(c), input, now);

  /**
   * Returned directly rather than through a `toActivity` projection, unlike `toUser` and
   * `toDevice`. Those two serialise a row the **repository read**, which carries `pk`, `sk`,
   * `entity` and every future storage attribute. This is the domain object the service just
   * constructed field by field; it has never been near DynamoDB and there is nothing on it to
   * strip. The route test asserts that — if this ever starts returning what was read, the
   * assertion fails rather than the leak shipping.
   */
  return c.json(
    {
      data: activity,
      meta: { requestId: c.get('requestId') },
    },
    201,
  );
}
