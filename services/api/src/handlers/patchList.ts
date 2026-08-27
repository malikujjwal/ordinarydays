import type { PatchListInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import { entityTag } from '../lib/etag.js';
import {
  DURABLE_OUTBOX_IDEMPOTENCY_TTL_SECONDS,
  IDEMPOTENCY_TTL_SECONDS,
} from '../lib/idempotency.js';
import { requireUserId } from '../middleware/identity.js';
import { patchListSettings } from '../services/listMutationService.js';
import { idempotentJson } from './idempotentResponse.js';
import { toListSettings } from './toList.js';

/**
 * `PATCH /v1/lists/:id` — title, capabilities, slot and archive (`api-contract.md` §2.7).
 *
 * ## `If-Match` is required, and its absence is a `400`
 *
 * The same rule, for the same reason, as `PATCH /v1/activities/:id`: a client that omits the
 * header is a client that would overwrite somebody's edit without knowing, so the request is
 * refused rather than served unconditionally. `validation_failed` and not `428`, because the
 * `ErrorCode` union is closed and a missing required header is a malformed request everywhere
 * else this API looks at one (P1-13).
 *
 * List **items** deliberately have no `If-Match`: per-field last-write-wins on a checkbox is
 * right, and optimistic concurrency on every tick in a grocery list would produce constant
 * spurious `409`s. A settings change is the opposite case — one row, whole-object semantics,
 * and a user looking at a settings sheet they opened some time ago.
 *
 * `Idempotency-Key` preserves the exact settings response, including the opaque Undo token.
 * `If-Match` alone cannot do that: after a lost response, the version has moved and the token
 * cannot be reconstructed from the canonical List row.
 */
export const PATCH_LIST_PATH = '/:id';

const MISSING = 'This edit needs an If-Match header carrying the version you loaded.';

function settingsReceiptTtlSeconds(data: unknown): number {
  if (typeof data !== 'object' || data === null) return IDEMPOTENCY_TTL_SECONDS;
  return 'undoToken' in data && 'undoExpiresAt' in data
    ? DURABLE_OUTBOX_IDEMPOTENCY_TTL_SECONDS
    : IDEMPOTENCY_TTL_SECONDS;
}

export async function patchListHandler(
  c: Context<AppEnv, typeof PATCH_LIST_PATH>,
  patch: PatchListInput,
  now: string,
): Promise<Response> {
  const header = c.req.header('If-Match');
  if (header === undefined || header.trim() === '') {
    throw new AppError('validation_failed', MISSING, [
      { path: 'If-Match', message: MISSING },
    ]);
  }

  return idempotentJson(
    c,
    200,
    async (receiptFor) => {
      const result = await patchListSettings(
        requireUserId(c),
        c.req.param('id'),
        patch,
        entityTag(header.trim()),
        now,
        { receiptFor: (stored) => receiptFor(toListSettings(stored)) },
      );
      return toListSettings(result);
    },
    { receiptTtlSeconds: settingsReceiptTtlSeconds },
  );
}
