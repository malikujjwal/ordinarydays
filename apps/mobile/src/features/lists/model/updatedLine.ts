import { type Instant, type TimeZone, toWallDate } from '@od/shared/time';
import { differenceInCalendarDays, parseISO } from 'date-fns';

/**
 * The card's footnote — `Updated today` (`design-system.md` §7.2, P3-47).
 *
 * ## It renders `lastItemActivityAt`, never `updatedAt`
 *
 * The two fields are not interchangeable, and the wrong one is wrong in a way a reader would
 * notice without being able to name. `updatedAt` backs `If-Match`: it moves on a rename or a
 * settings change and **does not move when an item is checked**. A card using it would say
 * `Updated 3 days ago` immediately after the list was used for the thing it exists for, and
 * would jump to `Updated today` because someone renamed it. `lastItemActivityAt` moves on every
 * item write and on nothing else (`data-model.md` §4.6), which is what the line means.
 *
 * This module cannot enforce which field it was handed. The enforcement is the row component's
 * single call site and the test that changes `updatedAt` alone and expects the line not to move.
 *
 * ## Calendar days, in the viewer's zone
 *
 * `today`/`yesterday` are calendar facts, not 24-hour windows: something written at 23:50 is
 * `Updated yesterday` at 00:10, not `Updated today` for another twenty-three hours.
 *
 * Both instants are reduced to wall dates through `@od/shared/time`'s `toWallDate` rather than
 * a local `formatInTimeZone` call — `coding-standards.md` §4.2 keeps zone conversion in one
 * place, and the shared helper is that place. The two wall dates then differ by whole calendar
 * days, which `parseISO` on a bare `YYYY-MM-DD` makes exact: both parse to local midnight, so
 * the difference has no DST or offset term left in it.
 *
 * No `new Date()` here — `now` arrives from the caller, which is the edge (§4.3).
 */

/** How long ago is worth counting in days. Past a week the card gets coarser, not longer. */
const WEEK = 7;

export function updatedLine(
  lastItemActivityAt: Instant,
  now: Instant,
  timezone: TimeZone,
): string {
  const then = toWallDate(lastItemActivityAt, timezone);
  const today = toWallDate(now, timezone);
  const days = differenceInCalendarDays(parseISO(today), parseISO(then));

  // Clamped at zero: a clock that is behind the server's writes should read as `today`, not as
  // a negative count rendered as `Updated -1 days ago`.
  if (days <= 0) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < WEEK) return `Updated ${String(days)} days ago`;
  if (days < 14) return 'Updated last week';

  const weeks = Math.floor(days / WEEK);
  if (days < 60) return `Updated ${String(weeks)} weeks ago`;

  const months = Math.floor(days / 30);
  return months < 12 ? `Updated ${String(months)} months ago` : 'Updated over a year ago';
}
