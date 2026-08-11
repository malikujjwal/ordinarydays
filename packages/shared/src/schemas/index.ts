/**
 * The `@od/shared/schemas` public surface.
 *
 * One barrel per declared `exports` subpath, and only those (`repo-structure.md` §6).
 * Resource schemas (`activity.ts`, `list.ts`, `person.ts`, `expense.ts`, …) are added here
 * by the phase tasks that write them.
 */
export * from './activity.js';
export * from './agenda.js';
export * from './capture.js';
export * from './common.js';
export * from './device.js';
export * from './envelope.js';
export * from './error.js';
export * from './health.js';
export * from './occurrence.js';
export * from './recurrence.js';
export * from './reminder.js';
export * from './schedule.js';
export * from './user.js';
