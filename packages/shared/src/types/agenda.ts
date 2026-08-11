import type { Reminder } from './reminder.js';
import type { ActivityStatus, ActivityType } from './vocabulary.js';

export type AgendaItemStatus =
  | ActivityStatus
  | 'completed_occurrence'
  | 'skipped_occurrence';

export interface AgendaCapabilities {
  complete: boolean;
  skip: boolean;
  snooze: boolean;
}

export interface AgendaParticipantAvatar {
  personId: string;
  displayName: string;
  avatarUrl?: string;
}

/** The trimmed, caller-specific row returned by `GET /v1/agenda`. */
export interface AgendaItem {
  activityId: string;
  occurrenceDate?: string;
  type: ActivityType;
  title: string;
  status: AgendaItemStatus;
  time?: string;
  endTime?: string;
  isRecurring: boolean;
  isSnoozed: boolean;
  hasCheckbox: boolean;
  capabilities: AgendaCapabilities;
  participantAvatars: AgendaParticipantAvatar[];
  participantCount: number;
  locationLabel?: string;
  subtitle?: string;
  isPast: boolean;
  reminders?: Reminder[];
  /** Original stored date when an incomplete task is rolled forward onto Today. */
  overdueFromDate?: string;
}

export type AgendaIncludeToken = 'anytime_unscheduled' | 'overdue' | 'reminders';
