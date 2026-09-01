import { differenceInWallDays } from '@od/shared/recurrence';
import type { ListItemPlanState } from '@od/shared/types';
import { format, parseISO } from 'date-fns';

/**
 * The caller-scoped Plan state line (P3-35, `plans-and-lists.md` §6.2).
 *
 * **`viewerPlan.status` selects the line**, and the mapping is closed:
 *
 * | status | line |
 * | --- | --- |
 * | `scheduled` with a date | `Planned Saturday · 7 PM` — `Next session …` for a `watch` Plan |
 * | `completed` with a date | `Done Saturday` |
 * | `cancelled` | `Cancelled`, no date suffix |
 * | `saved` | nothing — no date, so no line |
 * | `skipped` | nothing, defensively — a skip clears the pointer, so a `skipped` projection is stale |
 *
 * Link presence alone is never display eligibility (§6.2): an unscheduled Plan keeps its
 * pointer and renders no line until it is rescheduled.
 *
 * `today` is injected, never read from a clock (`coding-standards.md` §4.3): the route is the
 * edge, and `Saturday` has to mean the same thing in every test and timezone.
 */

/** Weekday name within the next 7 days, otherwise `d MMM` — the row's relative vocabulary. */
function relativeDate(date: string, today: string): string {
  const days = differenceInWallDays(date, today);
  const parsed = parseISO(date);
  if (days >= 0 && days <= 6) return format(parsed, 'EEEE');
  return format(parsed, 'd MMM');
}

/** `7 PM` on the hour, `7:30 PM` otherwise — the compact form §6.2's examples draw. */
function compactTime(time: string): string {
  const [hours = '0', minutes = '00'] = time.split(':');
  const hour = Number.parseInt(hours, 10);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return minutes === '00' ? `${display} ${suffix}` : `${display}:${minutes} ${suffix}`;
}

/** The full spoken time, `7:00 PM`, for the accessibility label (§6.2's grammar). */
function spokenTime(time: string): string {
  const [hours = '0', minutes = '00'] = time.split(':');
  const hour = Number.parseInt(hours, 10);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${minutes} ${suffix}`;
}

function verbFor(viewerPlan: ListItemPlanState): string | undefined {
  if (viewerPlan.status === 'scheduled') {
    return viewerPlan.type === 'watch' ? 'Next session' : 'Planned';
  }
  if (viewerPlan.status === 'completed') return 'Done';
  return undefined;
}

function datedLine(
  viewerPlan: ListItemPlanState,
  today: string,
  time: (value: string) => string,
  joiner: string,
): string | undefined {
  if (viewerPlan.status === 'cancelled') return 'Cancelled';
  const verb = verbFor(viewerPlan);
  const date = viewerPlan.schedule?.date;
  if (verb === undefined || date === undefined) return undefined;
  const when = relativeDate(date, today);
  const at = viewerPlan.schedule?.time;
  /* Completion is about the day it happened; the hour would read as an appointment. */
  if (viewerPlan.status === 'completed' || at === undefined) return `${verb} ${when}`;
  return `${verb} ${when}${joiner}${time(at)}`;
}

export function planStateLine(
  viewerPlan: ListItemPlanState | undefined,
  today: string,
): string | undefined {
  if (viewerPlan === undefined) return undefined;
  return datedLine(viewerPlan, today, compactTime, ' · ');
}

/**
 * The same line in §6.2's spoken grammar — unabbreviated time, no interpunct, because a
 * screen reader pronounces `·` unpredictably. The row appends `, open plan`.
 */
export function spokenPlanStateLine(
  viewerPlan: ListItemPlanState | undefined,
  today: string,
): string | undefined {
  if (viewerPlan === undefined) return undefined;
  return datedLine(viewerPlan, today, spokenTime, ' ');
}
