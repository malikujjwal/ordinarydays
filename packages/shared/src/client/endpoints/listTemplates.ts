import type { z } from 'zod';
import { envelope } from '../../schemas/envelope.js';
import { listTemplate } from '../../schemas/list.js';
import type { HttpClient } from '../http.js';

/**
 * `GET /v1/list-templates` (`api-contract.md` §2.7).
 *
 * ## Nothing on the mobile startup path calls this
 *
 * The creation sheet (P3-26) renders P3-07's **bundled projection** of the same shared
 * `LIST_TEMPLATES` module, so choosing a style works on first launch with no network at all.
 * This endpoint exposes that identical module to other clients and to contract tests. It is
 * not a second catalogue and not a startup dependency, and a hook that awaited it before
 * drawing the sheet would turn an offline-capable screen into an online one.
 *
 * ## The conditional GET is the client's, not this function's
 *
 * The catalogue is static and cacheable for 24 hours. `If-None-Match` and the ETag pairing are
 * owned entirely by `createHttpClient` — it stores the ETag per identity and path, sends the
 * condition, and revalidates the cached body on a `304`. So this function sends no cache
 * header of its own; supplying one here would be stripped on the way through, because the
 * client deletes caller-supplied `If-None-Match` to keep the unpaired-304 recovery request
 * unconditional. Riding that machinery is the whole point of doing nothing special here.
 */

export const listTemplatesResponse = envelope(listTemplate.array());

export type ListTemplate = z.infer<typeof listTemplate>;

/** The exact shared template catalogue, in its fixed order. */
export function getListTemplates(
  client: HttpClient,
  signal?: AbortSignal,
): Promise<ListTemplate[]> {
  return client
    .request({
      method: 'GET',
      path: '/v1/list-templates',
      schema: listTemplatesResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}
