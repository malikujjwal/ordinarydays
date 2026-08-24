import { LIST_TEMPLATES } from '@od/shared/lists';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { LIST_TEMPLATES_PATH, listTemplatesHandler } from '../handlers/listTemplates.js';
import { weakEntityTag } from '../lib/etag.js';

/**
 * `/v1/list-templates` (`api-contract.md` §2.7, P3-06).
 *
 * One route, and the only module in `services/api` allowed to name the catalogue — the
 * `list-templates-are-creation-data` allow list in `.dependency-cruiser.cjs` and
 * `scripts/check-forbidden.mjs` names this file and the creation service, and nothing else.
 * A renderer or stored-List read path that reached for `LIST_TEMPLATES[list.templateKey]`
 * is the bug that boundary exists to stop (ADR-032).
 *
 * **The mobile creation sheet does not depend on this route.** It renders P3-07's bundled
 * projection of the same shared module, so first-launch offline creation needs no request
 * and no client owns a second map of labels or defaults. This endpoint exists for clients
 * that do not bundle the catalogue.
 */

/**
 * Computed **once at module load**, from the canonical JSON of the catalogue itself.
 *
 * The catalogue is a shipped constant, so the tag is too: every request in a warm Lambda
 * reuses it, and a release that edits, adds or reorders a record produces a different tag
 * that invalidates every cached copy. Hashing per request would burn CPU to reach the same
 * answer; hard-coding a version string would be a second thing to remember to bump.
 *
 * **Weak**, because the envelope's `meta.requestId` differs on every response even though
 * the catalogue does not — so no tag over this payload can honestly claim byte-identity.
 * See `lib/etag.ts` for the full reasoning.
 */
const CATALOGUE_ETAG = weakEntityTag(LIST_TEMPLATES);

export const listTemplates = new Hono<AppEnv>().get(LIST_TEMPLATES_PATH, (c) =>
  listTemplatesHandler(c, LIST_TEMPLATES, CATALOGUE_ETAG),
);
