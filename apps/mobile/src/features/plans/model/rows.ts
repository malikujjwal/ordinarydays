import type { ActivityListItem } from '@od/shared/types';
import { format, parse } from 'date-fns';

/**
 * How one flat-list row reads (P1-23).
 *
 * Pure, so the string a row shows and the state it renders in are unit-testable without a
 * navigator, a query client or a rendered tree (`agent-playbook.md` §9 step 6).
 */

/** `design-system.md` §5.3's separator, used everywhere a row joins two facts. */
const SEPARATOR = ' · ';

/**
 * The reference instant `parse` fills the unspecified fields from. Fixed at the epoch rather
 * than `new Date()`: only hours and minutes are read back out, and a reference that moved
 * would make this depend on the day it ran (`coding-standards.md` §11 smell 6).
 */
const TIME_REFERENCE = new Date(0);

/**
 * `19:30` → `7:30 PM` (`design-system.md` §7.3), via `date-fns` because
 * `coding-standards.md` §4.4 rules out slicing the string.
 *
 * A third spelling of this rule, and deliberately not a cross-feature import:
 * `features/activity/model/dates.ts` has the same three lines, and `check-forbidden`'s
 * `client-layer-rules` bans one feature reaching into another's model. Both move to
 * `packages/shared/src/time/` when that module lands — P1-26 recorded the same intent for its
 * copy, and no task owns it yet.
 */
const formatWallTime = (time: string): string =>
  format(parse(time, 'HH:mm', TIME_REFERENCE), 'h:mm a');

/**
 * The row's second line: its time, then whatever the server already computed.
 *
 * The subtitle arrives built — one format per type, from `deriveSubtitle` in the repository —
 * so this joins rather than composes. Building a second one here would be the two-spellings
 * drift `tech-stack.md` §5.1 warns about, on a string the user reads.
 *
 * **There is no date.** `ActivityListItem` carries `time` and not `date` (P1-16), so an
 * `upcoming` row says when in the day but not which day. That is a limitation of this stage's
 * projection, not of this function: the dated, grouped presentation is `GET /v1/plans` and
 * P3-14.
 */
export function rowSubtitle(item: ActivityListItem): string | undefined {
  const parts = [
    item.time === undefined ? undefined : formatWallTime(item.time),
    item.subtitle,
  ].filter((part): part is string => part !== undefined && part !== '');

  return parts.length === 0 ? undefined : parts.join(SEPARATOR);
}

export interface RowState {
  /** Completed, skipped and cancelled rows recede rather than disappear. */
  dimmed: boolean;
  /** Only completion strikes the title — a skipped plan was never done, not undone. */
  struck: boolean;
}

export function rowState(item: ActivityListItem): RowState {
  return {
    dimmed: item.status !== 'saved' && item.status !== 'scheduled',
    struck: item.status === 'completed',
  };
}

/**
 * What a screen reader hears instead of "Gym, 7:30 PM · Zahav".
 *
 * `isRecurring` is rendered as a visible marker beside the title, and a marker with no words
 * is a fact only sighted users get (`design-system.md` §5.2's rule, applied to a row). It goes
 * into the label instead of becoming a second focus stop.
 */
export function rowLabel(item: ActivityListItem): string {
  const parts = [item.title, rowSubtitle(item)].filter(
    (part): part is string => part !== undefined,
  );

  if (item.isRecurring) parts.push('Repeats');
  if (item.status === 'completed') parts.push('Completed');

  return parts.join(SEPARATOR);
}
