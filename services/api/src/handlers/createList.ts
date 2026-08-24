import type { CreateListInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { createListFromTemplate } from '../services/listCreationService.js';
import { idempotentJson } from './idempotentResponse.js';
import { toList } from './toList.js';

/**
 * `POST /v1/lists` (`api-contract.md` §2.7).
 *
 * Three lines, like `createActivity`: validated input in, one service call, `201` with the
 * created list in the envelope. Template resolution, the owned-list cap, the source-Plan
 * check and the durable-id collision answer all live in `listCreationService` — a rule in a
 * handler is a rule the next endpoint re-derives slightly differently.
 *
 * The registry entry carries `mutates: true`, so the idempotency middleware requires the
 * `Idempotency-Key` and replays the stored response on a retry; the receipt joins the create
 * transaction through `idempotentJson`'s `receiptFor`, so a committed create and its stored
 * response are one atomic fact.
 */
export async function createListHandler(
  c: Context<AppEnv>,
  input: CreateListInput,
  now: string,
): Promise<Response> {
  return idempotentJson(c, 201, async (receiptFor) =>
    createListFromTemplate(requireUserId(c), input, now, (list) =>
      receiptFor(toList(list)),
    ),
  );
}
