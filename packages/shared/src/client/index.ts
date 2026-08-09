/**
 * The `@od/shared/client` public surface.
 *
 * One barrel per declared `exports` subpath (`repo-structure.md` §6). Endpoint functions are
 * added under `endpoints/` by the phase tasks that write them, and re-exported here as they
 * land — one file per resource, never one file with everything in it.
 */
export * from './endpoints/activities.js';
export * from './endpoints/capture.js';
export * from './endpoints/health.js';
export * from './http.js';
