import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { envelope } from './schemas/envelope.js';
import { errorResponse } from './schemas/error.js';
import { healthResponse } from './schemas/health.js';
import { patchUserInput, user } from './schemas/user.js';

/** `GET`/`PATCH /v1/me` both answer with the profile inside the standard envelope. */
const userResponse = envelope(user);

/**
 * The OpenAPI document, generated from the **same Zod schemas both sides import**
 * (`api-contract.md` §6). It is written to `docs/generated/openapi.json` by
 * `pnpm gen:openapi`, checked in, and CI fails when it is stale.
 *
 * That is the whole value: the spec cannot drift from the code, because it is not written
 * by hand. A new agent discovers the API here instead of by reading every handler, and can
 * trust what it reads — a hand-maintained spec is a document that is wrong in a way nobody
 * notices until a client has been built against it.
 *
 * **Registering an endpoint is part of adding one** (`agent-playbook.md` §7 step 15), not a
 * cleanup pass afterwards.
 *
 * There is no `extendZodWithOpenApi(z)` call here, and that is deliberate. That helper adds
 * `.openapi()` by patching zod, and the patch only reaches schemas **constructed after it
 * runs** — verified rather than assumed: an instance created before the call still has no
 * `.openapi` afterwards. Every schema in this package is built at module load, so whether
 * registration worked would depend on which module the import graph happened to reach
 * first. Each shape names itself with Zod 4's native `.meta({ id })` instead, which the
 * generator reads identically and which no import order can defeat.
 */
export const registry = new OpenAPIRegistry();

/**
 * **P1-06's schemas are not registered here, and cannot be.** Tried and reverted; the note
 * is what stops the next agent spending the same twenty minutes.
 *
 * `registry.register(id, schema)` is the API for adding a component without a path, and it
 * calls `zodSchema.openapi(refId)` internally — a method that exists only after
 * `extendZodWithOpenApi(z)` has patched Zod. This package deliberately does not call that
 * (see the note above): the patch reaches only schemas constructed *after* it runs, every
 * schema here is built at module load, and whether registration worked would then depend on
 * import order. Calling `register` without it throws `zodSchema.openapi is not a function`.
 *
 * So a shape reaches `components/schemas` when a **registered path references it**, and its
 * `.meta({ id })` supplies the name. `User`, `Activity`, `CreateActivityInput` and the rest
 * therefore appear as P1-07, P1-11 and their siblings mount routes — which is what
 * `agent-playbook.md` §7 step 15 already requires of every endpoint, so nothing is lost
 * except the illusion that this task could front-run it.
 */

/**
 * `/v1/me` (P1-07). The first authenticated pair, and the registration that brings `User`
 * and `PatchUserInput` into `components/schemas` — see the note above on why a shape reaches
 * the components map only when a registered path references it.
 */
registry.registerPath({
  method: 'get',
  path: '/v1/me',
  summary: 'The signed-in user’s profile',
  description:
    'Profile, preferences, timezone and currency. In local mode this answers for the ' +
    'seeded development user rather than `401`, which falls out of the `IdentityProvider` ' +
    'seam rather than being special-cased.',
  tags: ['me'],
  responses: {
    200: {
      description: 'The profile.',
      content: { 'application/json': { schema: userResponse } },
    },
    404: {
      description:
        'No profile for this user. The message never describes a developer workflow — ' +
        'the same path serves an account whose post-confirmation trigger failed.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/me',
  summary: 'Update preferences',
  description:
    'Accepts `displayName`, `timezone`, `currency`, `weekStartsOn`, ' +
    '`defaultReminderOffset` and `defaultLists` — and nothing else. The body schema is ' +
    'strict, so any other field is `400` naming it: `email`, `cognitoSub` and ' +
    '`onboardingState` belong to the auth flow. `defaultReminderOffset` takes any integer ' +
    'in `[-10080, 0]`, where `0` is a real "at the time" reminder and `null` clears it to ' +
    'Off — the two are different states, not two spellings of one.',
  tags: ['me'],
  request: {
    body: {
      content: { 'application/json': { schema: patchUserInput } },
    },
  },
  responses: {
    200: {
      description: 'The updated profile.',
      content: { 'application/json': { schema: userResponse } },
    },
    400: {
      description: 'A field outside the accepted set, or a value out of range.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No profile for this user.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/health',
  summary: 'Liveness and build identity',
  description:
    'Returns the deployed git SHA and stage. Performs no I/O — a liveness signal that ' +
    'fails because the table is throttled is not a liveness signal. Unauthenticated by ' +
    'exception in `routeSplit`, and the only route in `/v1` that is.',
  tags: ['system'],
  responses: {
    200: {
      description: 'The service is up.',
      content: { 'application/json': { schema: healthResponse } },
    },
    500: {
      description: 'Unexpected failure. The message is always the literal safe string.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

/**
 * Builds the document. Pure — it takes no arguments, reads no environment and writes no
 * file, so it can be asserted in a test. `scripts/gen-openapi.ts` is what puts it on disk.
 *
 * The return type is annotated rather than inferred because `OpenAPIObject` comes from
 * `openapi3-ts`, which `zod-to-openapi` does not re-export: inferring it produced TS2883,
 * "cannot be named without a reference … this is likely not portable". `openapi3-ts` is
 * therefore a declared dev dependency rather than a phantom one reached through another
 * package's `node_modules`.
 */
export function buildOpenApiDocument(): OpenAPIObject {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Ordinary Days API',
      version: '0.1.0',
      description:
        'The API behind Today, Plans and Lists. Generated from the Zod schemas in ' +
        '`packages/shared`; never edited by hand.',
    },
    /**
     * Present with one entry rather than omitted, even though there is no deployed URL yet
     * (P0-25). Phase 4 adds the `execute-api` host and Phase 5 the custom domain, and each
     * is then a one-line addition to an array that already exists — rather than a new key
     * appearing in the document and producing a diff that hides the change that mattered.
     */
    servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
  });
}
