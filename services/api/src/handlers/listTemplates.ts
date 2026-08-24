import type { ListTemplate } from '@od/shared/types';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { matchesIfNoneMatch } from '../lib/etag.js';

/**
 * `GET /v1/list-templates` (`api-contract.md` §2.7, P3-06).
 *
 * Returns the shipped catalogue **as data** — every field of every record, in catalogue
 * order — so a non-bundled client can preview exactly what a template will produce before
 * the user taps one. There is no filtering, no query parameter and no ranking: the order is
 * the contract (`plans-and-lists.md` §5.4), and choosing between records is the user's.
 *
 * ## Why the catalogue arrives as an argument
 *
 * The handler never names `LIST_TEMPLATES`. The catalogue is creation-time data behind an
 * import boundary (ADR-032, `list-templates-are-creation-data` in `.dependency-cruiser.cjs`
 * and `check-forbidden.mjs`), whose allow list names the **route** file. Taking it as a
 * parameter keeps the boundary exactly where P3-02 drew it, and makes acceptance criterion
 * 2 directly testable: a catalogue with one more record serialises through this same code
 * with no branch anywhere.
 *
 * ## No I/O
 *
 * No DynamoDB read, no repository import, nothing from `process.env`. The response is a
 * shipped constant, which is what makes it cacheable for 24 hours.
 */
export const LIST_TEMPLATES_PATH = '/';

/**
 * `public`, not `private`, on an authenticated route — the documented intent.
 *
 * Every other authed response here is per-user, which is why `securityHeaders` defaults to
 * `no-store`. This one is the shipped catalogue: identical for every caller, carrying no
 * user data, and correct for a shared cache to hold. Adding anything user-specific to this
 * payload would make the header a leak, so do not.
 */
export const LIST_TEMPLATES_CACHE_CONTROL = 'public, max-age=86400';

export function listTemplatesHandler(
  c: Context<AppEnv>,
  templates: readonly ListTemplate[],
  etag: string,
): Response {
  c.header('ETag', etag);
  c.header('Cache-Control', LIST_TEMPLATES_CACHE_CONTROL);

  if (matchesIfNoneMatch(c.req.header('If-None-Match'), etag)) {
    return c.body(null, 304);
  }

  return c.json({ data: templates, meta: { requestId: c.get('requestId') } });
}
