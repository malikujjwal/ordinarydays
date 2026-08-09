import type { PatchActivityInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import { requireUserId } from '../middleware/identity.js';
import { patchActivity } from '../services/activityService.js';

/**
 * `PATCH /v1/activities/:id` (`api-contract.md` §2.3).
 *
 * ## `If-Match` is required, and its absence is a `400`
 *
 * Optimistic concurrency is not opt-in: a client that omits the header is a client that would
 * overwrite somebody's edit without knowing, so the request is refused rather than served
 * unconditionally. `validation_failed` and not `428 Precondition Required`, because the
 * `ErrorCode` union is closed and a missing required header is a malformed request in every
 * other place this API looks at one (P1-13).
 *
 * The value is the `updatedAt` the client read. It is passed to the service as an opaque
 * string and never parsed here — comparing it is storage's job, and the conditional write is
 * where the comparison actually binds.
 */
export const PATCH_ACTIVITY_PATH = '/:id';

/**
 * Quoted or bare, both accepted.
 *
 * RFC 9110 writes an entity tag as `"value"`, and a well-behaved HTTP client will send it
 * that way; our own client sends the raw `updatedAt`. Accepting both costs one `replace` and
 * removes a class of report — "it works in curl but not in the app" — that would otherwise
 * be diagnosed from a `409` that looks like a genuine conflict.
 */
function entityTag(header: string): string {
  return header.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

const MISSING = 'This edit needs an If-Match header carrying the version you loaded.';

export async function patchActivityHandler(
  c: Context<AppEnv, typeof PATCH_ACTIVITY_PATH>,
  patch: PatchActivityInput,
  now: string,
): Promise<Response> {
  const header = c.req.header('If-Match');

  if (header === undefined || header.trim() === '') {
    throw new AppError('validation_failed', MISSING, [
      { path: 'If-Match', message: MISSING },
    ]);
  }

  const activity = await patchActivity(
    requireUserId(c),
    c.req.param('id'),
    patch,
    entityTag(header.trim()),
    now,
    c.get('logger'),
  );

  return c.json({
    data: activity,
    meta: { requestId: c.get('requestId') },
  });
}
