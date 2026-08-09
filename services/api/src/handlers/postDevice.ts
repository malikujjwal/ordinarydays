import type { RegisterDeviceInput } from '@od/shared/types';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { registerDevice } from '../services/deviceService.js';
import { toDevice } from './toDevice.js';

/**
 * `POST /v1/me/devices` (`api-contract.md` §2.1).
 *
 * `201`, because it creates a row with a new server-minted id. Its registry entry carries
 * `creates`, so `idempotency` (chain position 10) requires an `Idempotency-Key` and replays
 * the stored response on a retry — which matters more here than the verb suggests: the phone
 * that is registering has just come back from a permission prompt, mobile networks retry, and
 * without the key a timed-out request that actually succeeded leaves an orphaned device row
 * that nothing will ever delete, because the client never learned its id.
 */
export async function postDeviceHandler(
  c: Context<AppEnv>,
  input: RegisterDeviceInput,
  now: string,
): Promise<Response> {
  const device = await registerDevice(requireUserId(c), input, now);

  return c.json(
    {
      data: toDevice(device),
      meta: { requestId: c.get('requestId') },
    },
    201,
  );
}
