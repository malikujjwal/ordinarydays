import { z } from 'zod';
import { MAX_FREE_TEXT_LEN, MAX_TITLE_LEN } from '../constants.js';
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
    isSnoozed: z.boolean(),
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
