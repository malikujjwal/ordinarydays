import { z } from 'zod';
import type { TimeZone } from '../time/types.js';

/**
 * The primitives every other schema composes. Declared once, here.
 *
 * A resource schema never re-declares a date, a time, a money amount or an id — it
 * imports from this file. Two spellings of "HH:mm" is how the client and the server start
 * disagreeing about what they accept (`tech-stack.md` §5.1).
 */

/**
 * A wall-clock calendar date, `YYYY-MM-DD`, with no zone attached.
 *
 * `z.iso.date()` rather than a regex, because a regex accepts `2026-13-45` and this value
 * feeds recurrence expansion, where an impossible date becomes an impossible occurrence.
 */
export const isoDate = z.iso.date();

/** A wall-clock time of day, `HH:mm`, 24-hour, no seconds and no zone. */
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

/**
 * An IANA time zone name, e.g. `America/New_York`, plus the bare `UTC`.
 *
 * Structural validation only. Checking the name against the platform's actual tz database
 * would be stronger, but `Intl` support differs between Hermes and Node and this package
 * must behave identically on both; a server-side check belongs where the zone is used.
 */
export const ianaTimezone = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/,
    'Expected an IANA time zone, e.g. America/New_York',
  );

/** Runtime-validated IANA name branded for wall-clock conversion APIs. */
export const timeZone = ianaTimezone.transform((value) => value as TimeZone);

/**
 * A money amount in **integer cents**. Never a float, anywhere, ever (`CLAUDE.md` rule 4).
 *
 * Signed, because a net balance can be negative. Schemas for an amount someone actually
 * paid add `.positive()` themselves.
 */
export const cents = z.number().int('Money must be an integer number of cents').safe();

/**
 * A prefixed ULID, e.g. `act_01J8XK…` (`data-model.md` §8).
 *
 * 26 characters of Crockford base32, which excludes I, L, O and U so the alphabet has no
 * pairs that look alike in a log line. The first character is 0–7 because the 48-bit
 * timestamp cannot overflow into it until the year 10889.
 */
export function ulidId<P extends string>(prefix: P) {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`),
      `Expected a ${prefix}_ ULID`,
    );
}

/**
 * A user id: `usr_` followed by a ULID in production, but **not** asserted as one here.
 *
 * `LocalIdentityProvider` runs as the constant `usr_local_dev` for the whole of Phases 1–3
 * (P1-01), and a validator that rejects the id the system is currently running as is a
 * validator that gets deleted under pressure. So this is a prefixed-string check, and the
 * strict ULID assertion lives at the point where an id is **generated** — `newUserId()` in
 * P1-07 — which is the only place it can be enforced without lying about stored data.
 *
 * The bounds are wide enough for `usr_local_dev` (13) and a `usr_` ULID (30), and tight
 * enough that a key fragment cannot be smuggled through a user id.
 */
export const userId = z
  .string()
  .min(5)
  .max(40)
  .regex(/^usr_[A-Za-z0-9_-]+$/, 'Expected a usr_ id');

/**
 * An opaque pagination cursor: base64url of a DynamoDB `LastEvaluatedKey`.
 *
 * Opaque to the client by contract — it is decoded only by the cursor helper in the API.
 * Bounded so a hostile value cannot force an expensive decode.
 */
export const cursor = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Malformed cursor');

export type IsoDate = z.infer<typeof isoDate>;
export type Hhmm = z.infer<typeof hhmm>;
export type IanaTimezone = z.infer<typeof ianaTimezone>;
export type Cents = z.infer<typeof cents>;
export type UserId = z.infer<typeof userId>;
export type Cursor = z.infer<typeof cursor>;
