import { ApiError } from '@od/shared/client';
import type {
  Activity,
  ActivityChild,
  ActivityOutcome,
  ActivityScope,
} from '@od/shared/types';
import type { FollowUpNavigation } from '@/hooks/useFollowUp';

/**
 * The detail screen's action contract, owned once so the web (query cache) and native
 * (SQLite coordinator) adapters cannot drift apart, plus the `interaction-contract.md` §5.3
 * copy both use.
 */
export interface ActivityActions {
  duplicate: () => Promise<Activity | undefined>;
  remove: () => Promise<boolean>;
  /**
   * Stores a skip at an explicit scope; it never deletes the Activity.
   *
   * Widened from occurrence-only because `today-and-tasks.md` §5.4 puts a skip on "any task"
   * as well as any recurring occurrence — a one-off skips itself. The series guard that the
   * narrower type used to give structurally is now the same runtime one completion uses.
   */
  skip: (scope: ActivityScope) => Promise<boolean>;
  /**
   * Moves this activity, or this occurrence, later the same day. One `OCC#` row for a series
   * and META snooze fields for a one-off — the scope is explicit for the reason ADR-053 makes
   * it explicit.
   */
  snooze: (
    scope: ActivityScope,
    until: string,
    /** The day the row is rendered on, so the agenda projection can find it. */
    renderedDate: string,
  ) => Promise<boolean>;
  resolvePassed: (
    outcome: ActivityOutcome,
    scope: ActivityScope,
    onProjected: (resolved: boolean) => void,
  ) => void;
  /**
   * Reverses a completion from the detail screen.
   *
   * Separate from `resolvePassed`'s undo, which is the six-second toast. This is the permanent
   * affordance: a completed row on Today keeps its `Undo` swipe action for as long as it is
   * completed, and the detail screen — the one surface that can *record* a completion — could
   * not reverse one at all.
   */
  undoResolution: (
    scope: ActivityScope,
    onProjected?: (resolved: boolean) => void,
  ) => void;
  /** Complete or uncomplete one non-recurring Prep task from its parent's section. */
  setChildCompletion: (child: ActivityChild, completed: boolean) => Promise<boolean>;
  isBusy: boolean;
  /** The two halves stay separate so an optimistic Complete never disables its own Undo. */
  isCompleting: boolean;
  isUndoing: boolean;
  /** `interaction-contract.md` §5.3 copy for whichever action failed. */
  errorMessage: string | undefined;
  errorRequestId: string | undefined;
  retryError: () => void;
  dismissError: () => void;
}

export const ACTION_FAILED = "Couldn't do that.";
export const ACTIVITY_GONE = "This isn't here any more.";
export const OUTCOME_RECORDED = 'Outcome recorded';

export function describeActionFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'Only the person who made this plan can change that.';
    }
    if (error.status === 404) return ACTIVITY_GONE;
    if (error.status >= 500) return 'Something went wrong.';
    return error.message;
  }
  return ACTION_FAILED;
}

/** Per-screen options for `useActivityActions` (P3-44). */
export interface ActivityActionsOptions {
  /** Where a completion follow-up's navigation rows go. */
  followUp?: FollowUpNavigation;
}
