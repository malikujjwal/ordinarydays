import { assertNever } from '@od/shared';
import { describeRecurrence } from '@od/shared/recurrence';
import type { AgendaItem } from '@od/shared/types';
import { formatInTimeZone } from 'date-fns-tz';
import { deriveActionCapabilities } from './actionCapabilities.js';
import type { AgendaCandidate } from './agendaService.js';

const WALL_DATE = 'yyyy-MM-dd';
const WALL_TIME = 'HH:mm';

export interface AgendaProjectionClock {
  readonly now: string;
  readonly timezone: string;
  /** Request-window reference date used for deterministic recurrence copy. */
  readonly today: string;
}

/**
 * The first line of a note, clamped to a row's worth.
 *
 * The agenda serves up to 62 days of rows and notes run to 4,000 characters, so the whole field
 * never goes on the wire — the row shows one line and the detail screen owns the rest. Clamping
 * **here** rather than in the client is what keeps the payload bounded; a client-side `slice`
 * would have shipped every byte first.
 */
export function firstNoteLine(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined;
  const [first] = notes.split('\n');
  const trimmed = first?.trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  return trimmed.length <= NOTE_EXCERPT_LEN
    ? trimmed
    : `${trimmed.slice(0, NOTE_EXCERPT_LEN - 1).trimEnd()}…`;
}

/** One row's worth. Longer than a phone shows, short enough that 62 days stays bounded. */
const NOTE_EXCERPT_LEN = 120;

/** Builds the trimmed, caller-specific API row from an already-hydrated agenda candidate. */
export function projectAgendaItem(
  candidate: AgendaCandidate,
  clock: AgendaProjectionClock,
): AgendaItem {
  const { activity } = candidate;
  const subtitle = deriveSubtitle(activity, candidate.actionContext.parentTitle);
  const locationLabel = activity.location?.label;
  const noteExcerpt = firstNoteLine(activity.notes);

  return {
    activityId: activity.activityId,
    ...(candidate.occurrenceDate === undefined
      ? {}
      : { occurrenceDate: candidate.occurrenceDate }),
    ...(activity.parentActivityId === undefined
      ? {}
      : { parentActivityId: activity.parentActivityId }),
    type: activity.type,
    title: activity.title,
    status: candidate.status,
    ...(candidate.time === undefined ? {} : { time: candidate.time }),
    ...(candidate.endTime === undefined ? {} : { endTime: candidate.endTime }),
    isRecurring: activity.recurrence !== undefined,
    ...(activity.recurrence === undefined
      ? {}
      : { recurrenceDescription: describeRecurrence(activity.recurrence, clock.today) }),
    isSnoozed: candidate.isSnoozed,
    ...(candidate.originalTime === undefined
      ? {}
      : { originalTime: candidate.originalTime }),
    hasCheckbox: activity.type === 'task',
    capabilities: deriveActionCapabilities(candidate.actionContext),
    participantAvatars: candidate.participantAvatars.map((avatar) => ({ ...avatar })),
    participantCount: activity.participantCount,
    ...(locationLabel === undefined ? {} : { locationLabel }),
    ...(subtitle === undefined ? {} : { subtitle }),
    ...(noteExcerpt === undefined ? {} : { noteExcerpt }),
    isPast: isPast(candidate, clock),
    ...(candidate.reminders === undefined
      ? {}
      : { reminders: candidate.reminders.map((reminder) => ({ ...reminder })) }),
    ...(candidate.overdueFromDate === undefined
      ? {}
      : { overdueFromDate: candidate.overdueFromDate }),
  };
}

/** Projects a batch without adding repository access or other per-item I/O. */
export function projectAgendaItems(
  candidates: readonly AgendaCandidate[],
  clock: AgendaProjectionClock,
): AgendaItem[] {
  return candidates.map((candidate) => projectAgendaItem(candidate, clock));
}

function deriveSubtitle(
  activity: AgendaCandidate['activity'],
  parentTitle: string | undefined,
): string | undefined {
  switch (activity.details.kind) {
    case 'task':
      return parentTitle;
    case 'meal':
      return activity.details.mealSlot === undefined
        ? 'Meal'
        : `Meal · ${capitalise(activity.details.mealSlot)}`;
    case 'watch': {
      const { season, episode, mediaKind } = activity.details;
      if (season !== undefined && episode !== undefined) {
        return `Watch · S${season} E${episode}`;
      }
      return mediaKind === undefined ? 'Watch' : `Watch · ${capitalise(mediaKind)}`;
    }
    case 'event':
      return activity.details.organiser ?? activity.location?.label;
    case 'custom':
      return undefined;
    default:
      return assertNever(activity.details, 'ActivityDetails');
  }
}

function isPast(candidate: AgendaCandidate, clock: AgendaProjectionClock): boolean {
  const instant = new Date(clock.now);
  const today = formatInTimeZone(instant, clock.timezone, WALL_DATE);
  if (candidate.viewerDate !== today) return candidate.viewerDate < today;

  const boundary = candidate.endTime ?? candidate.time;
  if (boundary === undefined) return false;
  const now = formatInTimeZone(instant, clock.timezone, WALL_TIME);
  return boundary <= now;
}

const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
