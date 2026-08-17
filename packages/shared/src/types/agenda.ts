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
  /** Present exactly when this row is a prep task belonging to a parent plan. */
  parentActivityId?: string;
  type: ActivityType;
  title: string;
  status: AgendaItemStatus;
  time?: string;
  endTime?: string;
  isRecurring: boolean;
  /** Server-authored recurrence copy, present only for recurring items. */
  recurrenceDescription?: string;
  isSnoozed: boolean;
  /** Effective pre-snooze HH:mm, present only when snoozing changed the time. */
  originalTime?: string;
  hasCheckbox: boolean;
  capabilities: AgendaCapabilities;
  participantAvatars: AgendaParticipantAvatar[];
  participantCount: number;
  locationLabel?: string;
  subtitle?: string;
  /**
   * The **first line** of the activity's own notes, for the row's secondary line — added
   * 2026-08-17 on the founder's instruction.
   *
   * `AgendaItem` is a trimmed projection and stays trimmed (`agent-playbook.md` §8 step 13), so
   * this is not `Activity.notes`: notes are up to 4,000 characters and the agenda must not carry
   * them across the wire for every row of a 62-day window. The server sends one clamped line and
   * the row renders exactly that; the full note lives on the detail screen.
   *
   * Distinct from {@link subtitle}, which is server-composed **type metadata** (`Meal · Dinner`,
   * `S2 E4`, a parent plan's title). This is the user's own words.
   */
  noteExcerpt?: string;
  isPast: boolean;
  reminders?: Reminder[];
  /** Original stored date when an incomplete task is rolled forward onto Today. */
  overdueFromDate?: string;
}

export type AgendaIncludeToken = 'anytime_unscheduled' | 'overdue' | 'reminders';

export type AgendaWarning = 'series_limit_exceeded' | `duplicate_occurrence:${string}`;

export interface AgendaDay {
  date: string;
  upNext?: AgendaItem;
  schedule: AgendaItem[];
  anytime: AgendaItem[];
  earlier: AgendaItem[];
}

/** A GSI projection proven to match the canonical Activity version hydrated for the read. */
export interface AgendaProjectionVersion {
  activityId: string;
  version: string;
}

/** The stable payload hashed for `GET /v1/agenda`'s ETag. */
export interface AgendaData {
  days: AgendaDay[];
  warnings: AgendaWarning[];
  /** Optional only for wire compatibility with agenda bodies cached before P2-54. */
  projectionVersions?: AgendaProjectionVersion[];
}
