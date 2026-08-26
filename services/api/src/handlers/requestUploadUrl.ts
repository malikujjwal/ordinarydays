import type { RequestUploadUrlInput } from '@od/shared/types';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { requestUploadUrl } from '../services/attachmentService.js';
import { idempotentJson } from './idempotentResponse.js';

/** `POST /v1/attachments/upload-url` (`api-contract.md` §2.6, P3-21). */
export const UPLOAD_URL_PATH = '/upload-url';

/**
 * `201`, because the request creates a durable pending-upload record and mints the id every
 * later step addresses it by — even though no attachment exists yet and none may ever.
 *
 * Its registry entry carries `mutates: true`, so the `Idempotency-Key` middleware applies and
 * a replay answers with the originally issued URL rather than minting a second record. That
 * URL may by then have expired, which is the right way round: a client can ask for a fresh
 * one, and nothing can ask for a leaked record back.
 *
 * `new Date()` at the edge, as `activities.ts` does — `coding-standards.md` §4.3 bans an
 * implicit clock inside anything that has to be testable, so the route reads the real one and
 * hands it down as a value. Here it is load-bearing three times over: it stamps `createdAt`,
 * it sets the record's one-day expiry, and it is the instant the drain compares every existing
 * record against.
 */
export async function requestUploadUrlHandler(
  c: Context<AppEnv>,
  input: RequestUploadUrlInput,
  now: string,
): Promise<Response> {
  const log = c.get('logger');
  return idempotentJson(c, 201, async (receiptFor) =>
    requestUploadUrl(requireUserId(c), input, now, {
      receiptFor,
      ...(log === undefined ? {} : { log }),
    }),
  );
}
