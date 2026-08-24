import type { PatchActivityInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import { entityTag } from '../lib/etag.js';
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
 * where the comparison actually binds. Quoted, weak and bare forms are all accepted, by
 * the one reader in `lib/etag.ts` that every conditional route shares.
 */
export const PATCH_ACTIVITY_PATH = '/:id';

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
