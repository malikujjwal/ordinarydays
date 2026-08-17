import { pino } from 'pino';
import { config } from './config.js';

/**
 * One module-scope pino instance, created outside the handler and reused across warm
 * invocations (`tech-stack.md` §4.5).
 *
 * The redaction list is exhaustive and is `coding-standards.md` §7.3 verbatim. Adding a
 * field that could carry user content means adding it here in the same PR.
 *
 * What **is** logged: `userId`, `activityId`, `listId`, `personId`, `requestId` — all
 * opaque ULIDs. Where an email must be correlated, log `sha256(lowercased email)`.
 */
export const REDACTED_PATHS = [
  'email',
  '*.email',
  '*.*.email',
  'displayName',
  '*.displayName',
  '*.*.displayName',
  'title',
  '*.title',
  '*.*.title',
  'notes',
  '*.notes',
  /**
   * The agenda row's clamped first line of a note (2026-08-17). It is user content derived from
   * `notes`, which is redacted directly above — a shorter copy of a redacted field is still the
   * user's words, and `coding-standards.md` §7.3 is about the content, not the field name.
   */
  'noteExcerpt',
  '*.noteExcerpt',
  '*.*.noteExcerpt',
  'description',
  '*.description',
  'mediaTitle',
  '*.mediaTitle',
  'location',
  '*.location',
  'location.*',
  'address',
  '*.address',
  'lat',
  'lng',
  '*.lat',
  '*.lng',
  'phone',
  '*.phone',
  'expoPushToken',
  '*.expoPushToken',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers',
  'body',
  'rawModelOutput',
] as const;

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
  base: { stage: config.STAGE },
});

export type Logger = typeof logger;
