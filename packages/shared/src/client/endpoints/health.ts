import { type HealthData, healthResponse } from '../../schemas/health.js';
import type { HttpClient } from '../http.js';

/**
 * `GET /v1/health` (`api-contract.md` §2.1a).
 *
 * The first of the endpoint functions, and the template for all of them: one function per
 * endpoint, taking the client, naming the path once, and parsing with the **shared** schema
 * rather than a local shape. There is no second definition of what health looks like — the
 * API types its response against `healthResponse` and so does this.
 *
 * It returns `data` and drops `meta`, because health has no cursor and a caller that wants
 * the request id has the `ApiError` for the failing case. List endpoints will return the
 * envelope instead; that decision belongs to each endpoint, not to the client.
 */
export function getHealth(client: HttpClient, signal?: AbortSignal): Promise<HealthData> {
  return client
    .request({
      method: 'GET',
      path: '/v1/health',
      schema: healthResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((envelope) => envelope.data);
}
