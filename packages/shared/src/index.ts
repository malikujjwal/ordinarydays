/**
 * `@od/shared` — the isomorphic domain core.
 *
 * Re-exports the domain surface, so `import { … } from '@od/shared'` works for consumers
 * that do not want to name a subpath.
 *
 * `./client` is deliberately **not** re-exported here. Subpaths exist so a consumer cannot
 * accidentally pull in code it has no business having (`tech-stack.md` §3.3), and a root
 * barrel that re-exports everything would give that away. Import the API client as
 * `@od/shared/client`, explicitly.
 *
 * Nothing in this package imports React, React Native, an AWS SDK client, or `process.env`,
 * and nothing here builds a DynamoDB key (`tech-stack.md` §5.2).
 */
export * from './constants.js';
export * from './errors.js';
export * from './schemas/index.js';
export * from './table/index.js';
export * from './types/index.js';
