/**
 * Which routes this build serves, and whether each one needs an identity
 * (`phase-01-activity-core.md` P1-30).
 *
 * **Data and types only. This module imports nothing.** That is deliberate and it is the
 * reason the file exists separately from `routeSplit.ts`, which consumes it: `routeSplit`
 * needs `AppEnv` to type its own context, and `app-env.ts` needs {@link RouteAuth} to type
 * the context variable that carries it. Declaring the type in either of those two modules
 * makes them mutually dependent, which `dependency-cruiser`'s `no-circular` rule rejects —
 * type-only imports included, deliberately, since a type-only cycle is still a cycle at
 * build time. A leaf module both can import breaks it without a re-export.
 *
 * It follows the shape of `repositories/keys.ts`: one concern, nothing else in the file.
 */

/** Whether a route needs an identity, and what kind of surface it is. */
export type RouteAuth =
  /** Under `/public/v1/`. Reachable with no account; never sees a user id. */
  | 'public'
  /** Requires a resolved `userId`. Every route that touches user data. */
  | 'authenticated'
  /**
   * Under `/v1/` but deliberately open — `/v1/health`, which every smoke test and alarm
   * calls and which must answer before anything else works. Adding a second member is a
   * decision, not a convenience.
   */
  | 'unauthenticated-private';

/** The verbs this API uses. `ALL` is how Hono records a middleware, never a route. */
export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RouteEntryBase {
  readonly method: RouteMethod;
  /** The Hono path, verbatim — `/v1/activities/:id`, not a regex and not a prefix. */
  readonly pattern: string;
  readonly auth: RouteAuth;
  /**
   * Legacy P1-04 note: this classification is now the required `mutates` field on every POST.
   *
   * `api-contract.md` §1 requires the header on "all `POST` that create", which the method
   * alone cannot answer: capture POSTs are read-only, while completion and duplicate POSTs
   * mutate and require replay protection. Deriving it from the verb would require keys on
   * capture or let mutations through — so the route states it in the same place and for
   * the same reason it states whether it needs an identity.
   *
   * P2-38 broadens replay protection to every mutating POST and requires read-only POSTs to
   * opt out explicitly, so omission cannot silently bypass the middleware.
   */
}

/** Every POST is explicitly classified so a new mutation cannot silently bypass replay. */
export type RouteEntry =
  | (RouteEntryBase & { readonly method: 'POST'; readonly mutates: boolean })
  | (RouteEntryBase & {
      readonly method: Exclude<RouteMethod, 'POST'>;
      readonly mutates?: never;
    });

/**
 * Every route this build mounts, and whether it needs an identity.
 *
 * **Registering a route is part of adding one.** A task that mounts a route adds its line
 * here in the same pull request, exactly as `agent-playbook.md` §7 already requires for the
 * OpenAPI registration. Forgetting it is not a silent `501` three tasks later — it fails at
 * app construction, in every test, naming the route
 * (`assertRegistryMatchesRoutes` in `routeSplit.ts`).
 *
 * **One entry per line, grouped by resource, in the order `api-contract.md` §2 lists them.**
 * Ten Phase 1 tasks append to this array; keeping it one-per-line and in a stated order is
 * what makes two of those a conflict Git resolves rather than a reformatted block no
 * reviewer can read. This file is on the must-be-serial list in `roadmap.md` §5.4 and the
 * high-contention table in `git-workflow.md` §6.2.
 */
export const ROUTE_REGISTRY: readonly RouteEntry[] = [
  // §2.1 Me
  { method: 'GET', pattern: '/v1/me', auth: 'authenticated' },
  { method: 'PATCH', pattern: '/v1/me', auth: 'authenticated' },
  { method: 'POST', pattern: '/v1/me/devices', auth: 'authenticated', mutates: true },
  { method: 'DELETE', pattern: '/v1/me/devices/:deviceId', auth: 'authenticated' },

  // §2.2 Agenda
  { method: 'GET', pattern: '/v1/agenda', auth: 'authenticated' },

  // §2.2 Flat activity lists, and §2.3 Activities
  { method: 'GET', pattern: '/v1/activities', auth: 'authenticated' },
  { method: 'POST', pattern: '/v1/activities', auth: 'authenticated', mutates: true },
  { method: 'GET', pattern: '/v1/activities/:id', auth: 'authenticated' },
  { method: 'PATCH', pattern: '/v1/activities/:id', auth: 'authenticated' },
  { method: 'DELETE', pattern: '/v1/activities/:id', auth: 'authenticated' },
  {
    method: 'POST',
    pattern: '/v1/activities/:id/complete',
    auth: 'authenticated',
    mutates: true,
  },
  {
    method: 'POST',
    pattern: '/v1/activities/:id/uncomplete',
    auth: 'authenticated',
    mutates: true,
  },
  {
    method: 'POST',
    pattern: '/v1/activities/:id/duplicate',
    auth: 'authenticated',
    mutates: true,
  },

  /**
   * §2.11 Capture — stubs until Phase 8. **None of them mutates**: capture returns a draft
   * for the user to confirm and writes nothing, so there is no duplicate for an
   * `Idempotency-Key` to prevent (`agent-playbook.md` §6.12).
   */
  { method: 'POST', pattern: '/v1/capture/parse', auth: 'authenticated', mutates: false },
  {
    method: 'POST',
    pattern: '/v1/capture/extract',
    auth: 'authenticated',
    mutates: false,
  },
  { method: 'POST', pattern: '/v1/capture/link', auth: 'authenticated', mutates: false },

  // §2.1a Health
  { method: 'GET', pattern: '/v1/health', auth: 'unauthenticated-private' },
];
