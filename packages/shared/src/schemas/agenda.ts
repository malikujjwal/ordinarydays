import { z } from 'zod';
import { MAX_AGENDA_DAYS, MAX_FREE_TEXT_LEN, MAX_TITLE_LEN } from '../constants.js';
import { activityType } from './activity.js';
import { hhmm, ianaTimezone, isoDate, ulidId } from './common.js';
import { reminder } from './reminder.js';

export const agendaItemStatus = z.enum([
  'saved',
  'scheduled',
  'completed',
  'skipped',
  'cancelled',
  'completed_occurrence',
  'skipped_occurrence',
]);

export const agendaCapabilities = z.strictObject({
  complete: z.boolean(),
  skip: z.boolean(),
  snooze: z.boolean(),
});

export const agendaParticipantAvatar = z.strictObject({
  personId: z.string().min(1).max(40),
  displayName: z.string().min(1).max(MAX_FREE_TEXT_LEN),
  avatarUrl: z.url().optional(),
});

export const agendaItem = z
  .strictObject({
    activityId: ulidId('act'),
    occurrenceDate: isoDate.optional(),
    type: activityType,
    title: z.string().min(1).max(MAX_TITLE_LEN),
    status: agendaItemStatus,
    time: hhmm.optional(),
    endTime: hhmm.optional(),
    isRecurring: z.boolean(),
    recurrenceDescription: z.string().min(1).max(MAX_FREE_TEXT_LEN).optional(),
    isSnoozed: z.boolean(),
    originalTime: hhmm.optional(),
    hasCheckbox: z.boolean(),
    capabilities: agendaCapabilities,
    participantAvatars: z.array(agendaParticipantAvatar),
    participantCount: z.number().int().nonnegative(),
    locationLabel: z.string().max(MAX_FREE_TEXT_LEN).optional(),
    subtitle: z.string().max(MAX_TITLE_LEN).optional(),
    isPast: z.boolean(),
    reminders: z.array(reminder).optional(),
    overdueFromDate: isoDate.optional(),
  })
  .meta({ id: 'AgendaItem' });

export const agendaIncludeToken = z.enum(['anytime_unscheduled', 'overdue', 'reminders']);

const includeOptions = new Set<string>(agendaIncludeToken.options);

/** The comma-separated wire form used by the agenda query string. */
export const agendaInclude = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const tokens = value.split(',');
    if (
      tokens.length > agendaIncludeToken.options.length ||
      new Set(tokens).size !== tokens.length ||
      tokens.some((token) => !includeOptions.has(token))
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Expected distinct agenda include tokens: anytime_unscheduled, overdue, reminders',
      });
    }
  });

/** `GET /v1/agenda` query parameters, including its inclusive 62-day cap. */
export const agendaQuery = z
  .strictObject({
    from: isoDate,
    to: isoDate,
    tz: ianaTimezone,
    include: agendaInclude.optional(),
  })
  .superRefine((value, context) => {
    const from = wallDay(value.from);
    const to = wallDay(value.to);
    const inclusiveDays = to - from + 1;

    if (inclusiveDays < 1) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: "Expected 'to' to be on or after 'from'",
      });
    } else if (inclusiveDays > MAX_AGENDA_DAYS) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: `Agenda windows cannot exceed ${MAX_AGENDA_DAYS} days`,
      });
    }
  })
  .meta({ id: 'AgendaQuery' });

export type AgendaQuery = z.infer<typeof agendaQuery>;

/** Converts a query value only after {@link agendaQuery} has validated it. */
export function parseAgendaInclude(value: string | undefined) {
  return value === undefined
    ? []
    : value.split(',').map((token) => agendaIncludeToken.parse(token));
}

export const agendaWarning = z.union([
  z.literal('series_limit_exceeded'),
  z.templateLiteral(['duplicate_occurrence:', ulidId('act')]),
]);

export const agendaDay = z.strictObject({
  date: isoDate,
  upNext: agendaItem.optional(),
  schedule: z.array(agendaItem),
  anytime: z.array(agendaItem),
  earlier: z.array(agendaItem),
});

export const agendaData = z
  .strictObject({
    days: z.array(agendaDay).max(MAX_AGENDA_DAYS),
    warnings: z.array(agendaWarning),
  })
  .meta({ id: 'AgendaData' });

function wallDay(value: string): number {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}
