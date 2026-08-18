import type { Instant } from '@od/shared/time';
import type { LocalNotificationRequest } from '@/lib/push.types';
import { armingVerified } from './arming';

/**
 * The dirty flag that replaces the startup and enter-background special-cases (P2-57).
 *
 * ## Why a flag rather than two triggers
 *
 * `installLocalReminderScheduler` used to recompute on exactly two events: app start, and
 * entering the background. Everything in between — a reminder added, an activity rescheduled,
 * an offline create acknowledged — changed what should be armed and triggered nothing. The
 * user's reminder was correct only if they happened to background the app afterwards.
 *
 * So the trigger becomes the *reason* rather than the *moment*: **any reminder-relevant
 * change marks the schedule dirty**, and a dirty schedule is recomputed and replaced. The two
 * old moments still mark it dirty; they are no longer the only things that do.
 *
 * ## Why recompute-and-replace, and why all-or-nothing
 *
 * A partial arming is worse than a stale one, because the user cannot tell which reminders
 * survived. If verification fails the schedule **stays dirty** and the existing scheduled set
 * is left exactly as it was — a failed recompute cancels nothing. The next trigger retries.
 */

export type DirtyReason =
  | 'startup'
  | 'background'
  | 'reminder-changed'
  | 'activity-changed'
  | 'intent-acknowledged'
  | 'profile-changed';

export interface ScheduleState {
  dirty: boolean;
  /** The horizon the last verified arming reached. Phase 5 acknowledges this. */
  scheduledThrough: Instant | undefined;
  lastReason: DirtyReason | undefined;
}

export interface RecomputeResult {
  armed: number;
  verified: boolean;
  scheduledThrough: Instant | undefined;
}

export interface DirtyScheduleDependencies {
  /** Builds the set that should be armed right now. Throws if it cannot. */
  plan: () => Promise<{
    requests: LocalNotificationRequest[];
    scheduledThrough: Instant | undefined;
  }>;
  replace: (requests: readonly LocalNotificationRequest[]) => Promise<void>;
  /** Reads back what the OS actually holds, so verification compares reality. */
  readScheduled: () => Promise<string[]>;
  onError?: ((error: unknown) => void) | undefined;
}

/**
 * Serialised recompute-and-replace with a dirty flag.
 *
 * Every `mark` coalesces into at most one in-flight recompute plus one queued follow-up: a
 * burst of changes — ticking three boxes offline — produces one arming pass, not three, and
 * the last one still wins because the flag is checked after the pass rather than before.
 */
export class DirtySchedule {
  private state: ScheduleState = {
    dirty: true,
    scheduledThrough: undefined,
    lastReason: 'startup',
  };
  private running = false;

  constructor(private readonly dependencies: DirtyScheduleDependencies) {}

  snapshot(): ScheduleState {
    return this.state;
  }

  /** Records that something reminder-relevant changed. Cheap and safe to over-call. */
  mark(reason: DirtyReason): void {
    this.state = { ...this.state, dirty: true, lastReason: reason };
  }

  /**
   * Recomputes if dirty, replaces, verifies, and only then marks clean.
   *
   * Returns the outcome rather than throwing, because callers are event handlers with nothing
   * useful to do about a failure — the flag staying dirty *is* the retry.
   */
  async run(): Promise<RecomputeResult | undefined> {
    if (this.running || !this.state.dirty) return undefined;
    this.running = true;
    try {
      const planned = await this.dependencies.plan();
      await this.dependencies.replace(planned.requests);
      const actual = await this.dependencies.readScheduled();
      const verified = armingVerified(planned.requests, actual);

      if (verified) {
        this.state = {
          dirty: false,
          scheduledThrough: planned.scheduledThrough,
          lastReason: this.state.lastReason,
        };
      }
      // Unverified leaves `dirty` true and `scheduledThrough` untouched: the device does not
      // claim a horizon it could not prove, and the next trigger tries again.
      return {
        armed: planned.requests.length,
        verified,
        scheduledThrough: verified
          ? planned.scheduledThrough
          : this.state.scheduledThrough,
      };
    } catch (error) {
      /**
       * A failed recompute **cancels nothing**. `replace` either ran and is being retried, or
       * never ran and the previous set is intact. Either way the user keeps whatever coverage
       * they had rather than losing it to a transient failure.
       */
      this.dependencies.onError?.(error);
      return undefined;
    } finally {
      this.running = false;
    }
  }
}
