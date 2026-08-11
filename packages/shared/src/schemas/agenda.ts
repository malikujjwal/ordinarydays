import { z } from 'zod';
import { activityType } from './activity.js';
import { hhmm, isoDate, ulidId } from './common.js';
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

export const agendaCapabilities = z.object({
  complete: z.boolean(),
  skip: z.boolean(),
  snooze: z.boolean(),
});

export const agendaParticipantAvatar = z.object({
  personId: z.string().min(1),
  displayName: z.string().min(1),
  avatarUrl: z.url().optional(),
});

export const agendaItem = z
  .object({
    activityId: ulidId('act'),
    occurrenceDate: isoDate.optional(),
    type: activityType,
    title: z.string().min(1),
    status: agendaItemStatus,
    time: hhmm.optional(),
    endTime: hhmm.optional(),
    isRecurring: z.boolean(),
    isSnoozed: z.boolean(),
    hasCheckbox: z.boolean(),
    capabilities: agendaCapabilities,
    participantAvatars: z.array(agendaParticipantAvatar),
    participantCount: z.number().int().nonnegative(),
    locationLabel: z.string().optional(),
    subtitle: z.string().optional(),
    isPast: z.boolean(),
    reminders: z.array(reminder).optional(),
    overdueFromDate: isoDate.optional(),
  })
  .meta({ id: 'AgendaItem' });

export const agendaIncludeToken = z.enum(['anytime_unscheduled', 'overdue', 'reminders']);
