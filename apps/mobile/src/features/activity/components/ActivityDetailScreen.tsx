import type { ChangeTarget } from '@od/shared';
import { addWallDays, describeRecurrence } from '@od/shared/recurrence';
import type { PatchActivityInput } from '@od/shared/schemas';
import { type TimeZone, toWallDate, toWallTime } from '@od/shared/time';
import type {
  Activity,
  ActivityChild,
  ActivityDetailTarget,
  ActivityOutcome,
  PlanType,
  Recurrence,
} from '@od/shared/types';
import { type ActivityScope, activityScope, occurrenceScope } from '@od/shared/types';
import {
  Button,
  ChevronLeft,
  DisclosureRow,
  EmptyState,
  Field,
  IconButton,
  MoreHorizontal,
  RowGroup,
  ScreenShell,
  SettingRow,
  Sheet,
  Skeleton,
  Text,
  useTheme,
} from '@od/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent, View } from 'react-native';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PassedPlanResolutionSheet } from '@/components/PassedPlanResolutionSheet';
import { PendingNotice } from '@/components/PendingNotice';
import { SnoozeSheet } from '@/components/SnoozeSheet';
import { AddToPlanRow } from '@/features/activity/components/AddToPlanRow';
import { AttachmentsSection } from '@/features/activity/components/AttachmentsSection';
import { ChangeKindSheet } from '@/features/activity/components/ChangeKindSheet';
import { ListsSection } from '@/features/activity/components/ListsSection';
import { OverflowMenu } from '@/features/activity/components/OverflowMenu';
import { PrepSection } from '@/features/activity/components/PrepSection';
import {
  ReminderSheet,
  reminderSummary,
} from '@/features/activity/components/ReminderSheet';
import { RepeatSheet } from '@/features/activity/components/RepeatSheet';
import { RescheduleSheet } from '@/features/activity/components/RescheduleSheet';
import { UpdatesSection } from '@/features/activity/components/UpdatesSection';
import { WhenWhereBlock } from '@/features/activity/components/WhenWhereBlock';
import { useActivityDetail } from '@/features/activity/hooks/useActivity';
import {
  kindChangePatch,
  useActivityActions,
} from '@/features/activity/hooks/useActivityActions';
import { useActivityUpdates } from '@/features/activity/hooks/useActivityUpdates';
import {
  type Confirmation,
  deleteConfirmation,
  kindChangeConfirmation,
} from '@/features/activity/model/confirmations';
import type { WallDate } from '@/features/activity/model/dates';
import {
  canSkipOccurrence,
  canSnoozeOccurrence,
  effectiveSchedule,
  occurrenceAgendaItem,
} from '@/features/activity/model/occurrenceActions';
import {
  addToPlanChips,
  relativeUpdateTime,
} from '@/features/activity/model/planSections';
import { endRepeatSeries } from '@/features/activity/model/repeat';
import { sectionsFor, subtitleFor } from '@/features/activity/model/sections';
import { useClock } from '@/hooks/useClock';
import { useMinuteTicker } from '@/hooks/useMinuteTicker';
import { cancelPendingCreate, usePendingCreate } from '@/hooks/usePendingIntents';
import { openInMaps } from '@/lib/openInMaps';
import {
  completionVerb,
  isNegativeOutcome,
  outcomeVerb,
  passedPlanResolution,
} from '@/lib/passedPlanResolution';
import type { PendingActivity } from '@/lib/pendingActivity';
import { planKindLabel } from '@/lib/planKinds';
import { resolveViewerTimezone } from '@/lib/viewerTimezone';

/**
 * The Activity detail screen (P1-26).
 *
 * One `GET /v1/activities/:id`, composed server-side from exact strong reads and bounded
 * section prefixes. Editing is **in place**: there is no edit mode and no per-field Save
 * button. Text commits on blur, pickers commit on selection, and each issues its own `PATCH`
 * with `If-Match` (`activities.md` §6.1).
 *
 * ## The two rules this screen exists to hold
 *
 * - **Rule 6 / U1: tapping a row opens; it never mutates.** Nothing on this screen writes
 *   from a tap except the controls that are *about* writing — a field losing focus, a chip in
 *   the reschedule sheet.
 * - **U4: tapping a date or a time opens the reschedule sheet**, anywhere it is rendered. It
 *   never turns the row into an editable field. `WhenWhereBlock` owns that target.
 *
 * ## Layout at width
 *
 * `design-system.md` §8: single column at `compact`, capped and centred from `medium` up. The
 * cap is what stops a 1280 px browser rendering a 1200 px line of body text — the mock's
 * measure is ~620 pt and that is what the content column uses at `expanded`.
 *
 * The **two-pane master/detail** that §8 describes at `expanded` is *not* built here. It is a
 * shell concern — the left rail replacing the tab bar, a list pane owning selection, this
 * screen filling the right pane — and it belongs with the rail, which P1-23 has not built
 * either. At `expanded` this screen is therefore a centred column and pushes as a route, which
 * §8 names as the `medium` fallback: "nothing is lost, only rearranged". Flagged in the PR.
 */
export interface ActivityDetailScreenProps {
  /** Explicit route identity; there is no absent occurrence field to reinterpret. */
  target: ActivityDetailTarget;
  /** The user's today, in their zone. Injected so the quick chips are testable (§4.3). */
  today: WallDate;
  onBack: () => void;
  /** Where a duplicate lands: its own detail screen (P1-27, `activities.md` §7.1). */
  onOpenActivity: (activityId: string) => void;
  /** Opens one of this Plan's own Lists from its LISTS section (P3-37, P3-39). */
  onOpenList?: (listId: string) => void;
  /**
   * Opens a prep child's detail (P3-37). A push, unlike `onOpenActivity`'s replace: a child
   * is somewhere the user goes and comes back from, not a copy taking this screen's place.
   * Defaults to `onOpenActivity` when the route offers nothing better.
   */
  onOpenChild?: (activityId: string) => void;
  /**
   * `+ Add prep task` (P3-38): opens the Task form with this plan fixed as the parent. The
   * exact contextual action — the chip when PREP is empty, the section's own affordance once
   * it holds rows. Absent leaves both out.
   */
  onAddPrepTask?: () => void;
  /**
   * `+ Add list` (P3-39): opens the seven-type catalogue with this Plan as the source. Called
   * with the plan's title so the caller can show the context line and the `· <Plan title>`
   * prefill without re-reading the detail. Absent leaves the chip and the affordance out.
   */
  onAddList?: (planTitle: string) => void;
  /** Present only when navigation came from a passed, unresolved agenda row. */
  resolutionOccurrenceDate?: string | null;
  /** Keeps the route marker in sync with optimistic resolution, Undo, and request rollback. */
  onResolutionProjectionChange?: (resolved: boolean) => void;
}

/** A kind change waiting on its confirmation. Absent means nothing is being confirmed. */
interface PendingChange {
  target: ChangeTarget;
  confirmation: Confirmation;
}

export function ActivityDetailScreen({
  target,
  today,
  onBack,
  onOpenActivity,
  onOpenList,
  onOpenChild,
  onAddPrepTask,
  onAddList,
  resolutionOccurrenceDate,
  onResolutionProjectionChange,
}: ActivityDetailScreenProps) {
  const theme = useTheme();
  const activityId = target.activityId;
  const detail = useActivityDetail(target);
  const actions = useActivityActions(activityId);
  /**
   * Derived from pending-intent presentation, never from a field on the Activity (P2-50).
   * Native reads the account SQLite outbox presentation store. Pending-ness is
   * a property of what this device has queued, not of the entity — the server has no idea
   * this row exists, so it has nothing to tell us about it and no DTO carries it.
   */
  const pendingCreate = usePendingCreate(activityId);
  const [cancellingPending, setCancellingPending] = useState(false);

  async function cancelPending(): Promise<void> {
    if (pendingCreate.intentId === undefined) return;
    setCancellingPending(true);
    try {
      /**
       * Removes the intent and nothing else reaches the network — cancelling an unsent create
       * retracts a record that never left the device. The screen leaves because the entity it
       * was about no longer exists anywhere.
       */
      if (await cancelPendingCreate(pendingCreate.intentId)) onBack();
    } finally {
      setCancellingPending(false);
    }
  }
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [kindSheet, setKindSheet] = useState<'planKind' | 'toPlan' | undefined>(
    undefined,
  );
  const [pending, setPending] = useState<PendingChange | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteSeriesConfirmOpen, setDeleteSeriesConfirmOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [updatesPaginationSignal, setUpdatesPaginationSignal] = useState(0);
  const handleDetailScroll = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
      if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 160) {
        setUpdatesPaginationSignal((current) => current + 1);
      }
    },
    [],
  );
  const targetIdentity =
    target.kind === 'activity'
      ? `activity:${target.activityId}`
      : `occurrence:${target.activityId}:${target.date}`;
  const [promotedOccurrence, setPromotedOccurrence] = useState<
    | {
        targetIdentity: string;
        date: string;
      }
    | undefined
  >(undefined);
  /**
   * The snooze sheet prunes options that are already past, so the minute has to keep moving
   * **while that sheet is open** — a value captured at mount would start offering times the
   * server rejects. Gated on the sheet, because a detail screen re-rendering every sixty
   * seconds for a control nobody has opened is churn, and it put a visible one-minute beat on a
   * screen whose updates are supposed to be driven by writes.
   */
  const tick = useMinuteTicker(snoozeOpen);
  const [resolutionDismissed, setResolutionDismissed] = useState(false);
  /**
   * This screen's own projection of the resolution — `undefined` until the user acts here, at
   * which point it outranks the cached agenda.
   *
   * Every path that projects a completion or reverses one moves it, including the rollbacks,
   * which is why it is fed from one `onProjected` callback rather than set beside the calls.
   *
   * **It carries the scope it was captured for.** Held as a bare boolean it outlived the thing
   * it described: dropping recurrence from the Repeat sheet, or rescheduling, changes
   * `actionOccurrenceDate` underneath it, and the old answer was then read as the new scope's.
   * A projection whose scope no longer matches is stale, and stale falls back to the cache.
   */
  const [projection, setProjection] = useState<
    | {
        scope: string | undefined;
        resolved: boolean;
        kind: ResolutionKind;
        outcome?: ActivityOutcome;
      }
    | undefined
  >(undefined);

  /**
   * A kind change confirms **only when it would drop something** (`activities.md` §6.3 rule 6,
   * `interaction-contract.md` §1a.1 rule 3). An additive change — Task → Plan, or any pair the
   * mapping carries whole — applies immediately with no dialog, because a confirmation that
   * can appear with nothing to name is a bug rather than caution.
   */
  function propose(current: Activity, target: ChangeTarget) {
    const confirmation = kindChangeConfirmation(
      current,
      target,
      detail.detail?.reminders.length ?? 0,
    );

    if (confirmation === undefined) {
      void applyKind(current, target);
      return;
    }
    setPending({ target, confirmation });
  }

  async function applyKind(current: Activity, target: ChangeTarget) {
    await detail.patch(kindChangePatch(current, target));
    setPending(undefined);
  }

  /** The copy opens in its own detail screen, titled `<title> (copy)` (§7.1). */
  async function duplicate() {
    const copy = await actions.duplicate();
    if (copy !== undefined) onOpenActivity(copy.activityId);
  }

  /** Delete has no undo (§6.4), so the screen leaves only once the server has agreed. */
  async function remove() {
    if (await actions.remove()) {
      setDeleteOpen(false);
      setDeleteSeriesConfirmOpen(false);
      onBack();
    }
  }

  const activity = detail.detail?.activity;
  const authoritativeActivity =
    activity !== undefined && !pendingCreate.pending && !('pending' in activity)
      ? activity
      : undefined;
  const showResolutionPrompt =
    resolutionOccurrenceDate !== undefined &&
    activity?.status === 'scheduled' &&
    detail.detail?.capabilities?.complete === true &&
    !resolutionDismissed;
  /**
   * The server normally echoes the explicit nominal occurrence target supplied by navigation.
   * There is one safe transition exception: this mounted screen can turn the one-off it was
   * already about into a series. Preserve that exact former one-off date so the action remains
   * occurrence-scoped after the response gains recurrence. A generic series route never sets
   * this value and therefore still cannot complete the whole series accidentally.
   */
  const actionOccurrenceDate =
    detail.detail?.occurrence?.nominalDate ??
    (activity?.recurrence === undefined ||
    promotedOccurrence?.targetIdentity !== targetIdentity
      ? undefined
      : promotedOccurrence.date);

  async function commitRecurrence(recurrence: Recurrence | undefined): Promise<boolean> {
    if (authoritativeActivity === undefined) return false;
    const promotedDate =
      authoritativeActivity.recurrence === undefined && recurrence !== undefined
        ? authoritativeActivity.schedule?.date
        : undefined;
    if (promotedDate !== undefined) {
      // Establish the scope before the server response updates the cached Activity to recurring.
      // Otherwise that render can briefly look like a generic series and hide Complete.
      setPromotedOccurrence({ targetIdentity, date: promotedDate });
    }
    const accepted = await detail.patch({
      recurrence: recurrence ?? null,
      ...(recurrence !== undefined &&
      authoritativeActivity.recurrence !== undefined &&
      recurrence.segments.length > authoritativeActivity.recurrence.segments.length &&
      actionOccurrenceDate !== undefined
        ? { editedFromDate: actionOccurrenceDate }
        : {}),
    });
    if (!accepted && promotedDate !== undefined) {
      setPromotedOccurrence((current) =>
        current?.targetIdentity === targetIdentity && current.date === promotedDate
          ? undefined
          : current,
      );
    }
    return accepted;
  }

  /**
   * A series reached without an occurrence offers no completion control.
   *
   * `POST /complete` sent bare sets `status: 'completed'` on the series row itself and retires
   * every future occurrence (verified against the local API) — rule 3 broken by one tap. What a
   * series detail screen *should* offer is **P2-47**'s open question, and absence is the honest
   * answer until it has one.
   */
  /** One value the whole screen acts through, rather than a date each field re-reads. */
  const actionScope: ActivityScope =
    actionOccurrenceDate === undefined
      ? activityScope()
      : occurrenceScope(actionOccurrenceDate);

  async function removeOccurrence() {
    if (actionOccurrenceDate === undefined) return;
    if (await actions.skip(occurrenceScope(actionOccurrenceDate))) {
      setDeleteOpen(false);
      onBack();
    }
  }

  async function endSeriesFromDelete() {
    if (
      authoritativeActivity?.recurrence === undefined ||
      actionOccurrenceDate === undefined
    )
      return;
    if (
      await detail.patch({
        recurrence: endRepeatSeries(
          authoritativeActivity.recurrence,
          actionOccurrenceDate,
        ),
      })
    ) {
      setDeleteOpen(false);
    }
  }

  /**
   * The schedule this screen is **about**.
   *
   * With an occurrence in scope that is the occurrence's own date and time, not the series'.
   * An `Occurrence` override never moves `ACT#/META`, so `activity.schedule` keeps reporting
   * the series value after the user has changed the day in front of them — which showed back a
   * time they had not set, inviting a second "correction" and a second override.
   */
  const shownSchedule = effectiveSchedule(activity, detail.detail?.occurrence);

  const seriesWithoutOccurrence =
    activity?.recurrence !== undefined && actionOccurrenceDate === undefined;
  const futureRecurringOccurrence =
    activity?.recurrence !== undefined &&
    actionOccurrenceDate !== undefined &&
    actionOccurrenceDate > today;

  /**
   * Resolution state for whatever is in scope.
   *
   * A one-off's is on the Activity. An occurrence's is not readable from its series at all, so
   * it comes from this screen's own projection once the user has acted, and before that from
   * the authoritative occurrence detail response. A projection captured under a different
   * scope is ignored rather than believed.
   */
  const resolved =
    projection !== undefined && projection.scope === actionOccurrenceDate
      ? projection.resolved
      : actionOccurrenceDate === undefined
        ? RESOLVED_STATUSES.has(activity?.status ?? '')
        : RESOLVED_STATUSES.has(detail.detail?.occurrence?.status ?? '');

  /**
   * **Which resolution the screen is showing, not merely that there is one.**
   *
   * A skip and a completion are different outcomes with different reversals, and this used to
   * read `activity.status === 'skipped'` alone — which is never true for an *occurrence*, whose
   * skip lives on the `Occurrence` and leaves `ACT#/META` untouched. Skipping today's Gym
   * therefore reported the completion verb, in the success colour, under a button labelled
   * `Undo`. The status the screen is actually about is the same one `resolved` is read from.
   */
  const liveProjection =
    projection !== undefined && projection.scope === actionOccurrenceDate
      ? projection
      : undefined;

  const resolutionKind: ResolutionKind =
    liveProjection?.kind ??
    (SKIPPED_STATUSES.has(
      (actionOccurrenceDate === undefined
        ? activity?.status
        : detail.detail?.occurrence?.status) ?? '',
    )
      ? 'skipped'
      : 'completed');

  /**
   * The outcome the resolved block reports: the optimistic one while a write is in flight, the
   * stored one afterwards.
   *
   * **Only the Activity's own.** `OccurrenceDetailProjection` carries `status` but not
   * `outcome`, so a *recurring* occurrence resolved as `Didn't happen` reads back as a plain
   * skip once the projection replaces this screen's own answer. The row is written and the
   * server has the value; exposing it is a change to that projection and its schema, which is
   * a server task and is raised rather than guessed at here.
   */
  const resolutionOutcome: ActivityOutcome | undefined =
    liveProjection !== undefined ? liveProjection.outcome : activity?.outcome;

  /** One callback for the optimistic flip, the Undo, and every rollback in between. */
  function projectResolution(
    next: boolean,
    kind: ResolutionKind = 'completed',
    outcome?: ActivityOutcome,
  ) {
    setResolutionDismissed(next);
    setProjection({
      scope: actionOccurrenceDate,
      resolved: next,
      kind,
      ...(outcome === undefined ? {} : { outcome }),
    });
    onResolutionProjectionChange?.(next);
  }

  /**
   * Skipping from the reschedule sheet, projected before the request rather than after it.
   *
   * The write itself is one `OCC#` row and the agenda cache is corrected from the response, but
   * the *screen* had nothing to show until that response landed — the reported lag, measured as
   * the gap between the sheet closing and the resolved state appearing. Everything else on this
   * screen already projects first; this was the one action that did not.
   */
  /**
   * The occurrence in front of the user, as the shared snooze sheet and the two secondary
   * actions read it. `shownSchedule` rather than `activity.schedule`, because an override moves
   * the day in front of the user without moving `ACT#/META`.
   */
  const occurrenceContext = {
    occurrenceDate: actionOccurrenceDate,
    shownSchedule,
    capabilities: detail.detail?.capabilities,
    objectKind: activity?.objectKind,
    recurring: activity?.recurrence !== undefined,
  };
  const snoozeItem =
    activity === undefined
      ? undefined
      : occurrenceAgendaItem(activity, occurrenceContext);
  const currentMinute = toWallTime(
    tick.instant,
    // The same branding the agenda hooks apply at this boundary; the zone is a plain IANA name.
    (activity?.schedule?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone) as TimeZone,
  );

  /**
   * `today-and-tasks.md` §5.4: a skip is "available on any task and on any recurring
   * occurrence", so it runs at whatever scope the screen is about — the Activity itself for a
   * one-off, the day in view for a series. Requiring an occurrence dropped every one-off.
   */
  async function skipToday(): Promise<boolean> {
    if (!canSkipOccurrence(occurrenceContext)) return false;
    projectResolution(true, 'skipped');
    const ok = await actions.skip(actionScope);
    // The screen must not claim a skip the server refused.
    if (!ok) projectResolution(false, 'completed');
    return ok;
  }

  const detailContent = (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingBottom: theme.space[5],
        }}
        testID="detail-navigation"
      >
        <IconButton
          icon={ChevronLeft}
          label="Back"
          tone="accent"
          onPress={onBack}
          testID="detail-back"
        />
        {activity === undefined || pendingCreate.pending ? null : (
          <IconButton
            icon={MoreHorizontal}
            label="More"
            onPress={() => setMenuOpen(true)}
            testID="detail-overflow"
          />
        )}
      </View>

      {detail.status === 'pending' ? (
        // A skeleton matching the real layout's shape, not a spinner (§5.1).
        <View style={{ gap: theme.space[5] }} testID="detail-loading">
          <Skeleton shape="text" count={2} />
          <Skeleton shape="card" count={1} />
          <Skeleton shape="row" count={3} />
        </View>
      ) : detail.status === 'error' || activity === undefined ? (
        <View testID="detail-error">
          <EmptyState
            heading={detail.message ?? "Couldn't load this."}
            {...(detail.requestId === undefined ? {} : { body: detail.requestId })}
            action={{ label: 'Try again', onPress: detail.refetch }}
          />
        </View>
      ) : (
        <Loaded
          activity={activity}
          detail={detail}
          today={today}
          onOpenChild={onOpenChild ?? onOpenActivity}
          onToggleChild={actions.setChildCompletion}
          {...(actions.errorMessage === undefined
            ? {}
            : {
                actionErrorMessage: actions.errorMessage,
                ...(actions.errorRequestId === undefined
                  ? {}
                  : { actionErrorRequestId: actions.errorRequestId }),
                onRetryAction: actions.retryError,
                onDismissActionError: actions.dismissError,
              })}
          updatesPaginationSignal={updatesPaginationSignal}
          {...(onOpenList === undefined ? {} : { onOpenList })}
          {...(onAddPrepTask === undefined ? {} : { onAddPrepTask })}
          {...(onAddList === undefined ? {} : { onAddList })}
          onOpenReschedule={() => setRescheduleOpen(true)}
          onOpenRepeat={() => setRepeatOpen(true)}
          onOpenReminders={() => setRemindersOpen(true)}
          showResolutionPrompt={showResolutionPrompt}
          resolved={resolved}
          onOpenResolution={() => setResolutionOpen(true)}
          shownSchedule={shownSchedule}
          /**
           * **Every server-directed capability is false while the create is unacknowledged**
           * (P2-50, §5.4). Gated here rather than inside each control so the actions are
           * genuinely absent — a capability probe finds nothing, which is the assertion the
           * task asks for, rather than a styled-disabled button that still exists.
           */
          pending={pendingCreate.pending}
          pendingNeedsAttention={pendingCreate.status === 'needs_attention'}
          canCancelPending={pendingCreate.canCancel}
          onCancelPending={() => void cancelPending()}
          cancellingPending={cancellingPending}
          canComplete={
            detail.detail?.capabilities?.complete === true && !pendingCreate.pending
          }
          completionUnavailable={seriesWithoutOccurrence || futureRecurringOccurrence}
          completing={actions.isCompleting}
          undoing={actions.isUndoing}
          resolutionKind={resolutionKind}
          resolutionOutcome={resolutionOutcome}
          canSnooze={canSnoozeOccurrence(occurrenceContext) && !pendingCreate.pending}
          canSkip={canSkipOccurrence(occurrenceContext) && !pendingCreate.pending}
          skipsOneDay={actionOccurrenceDate !== undefined}
          onSnooze={() => setSnoozeOpen(true)}
          onSkip={() => void skipToday()}
          onComplete={() => {
            actions.resolvePassed(
              passedPlanResolution(activity.type).positive.outcome,
              actionScope,
              projectResolution,
            );
          }}
          onUndoResolution={() => {
            actions.undoResolution(actionScope, projectResolution);
          }}
        />
      )}
    </>
  );

  return (
    <View style={{ flex: 1 }}>
      {/**
       * `ScreenShell` owns the gutters, the centred column, the safe area and the vertical
       * breathing room — the four things this screen used to answer for itself, and answered
       * differently from the tabs. `reading` is §8's narrower measure: this screen is mostly
       * running text, and it is why the cap here was 620 against the tabs' 720.
       */}
      {/**
       * **No card around the screen.** From `medium` up this content used to sit inside an
       * elevated `Card`, which made a whole screen a hero surface — §2 allows one hero at a
       * time, and this screen's hero is its completion action. `ScreenShell` already gives the
       * centred column the card was standing in for, and only cards, sheets and the one hero
       * surface are rounded; rounding a page is the corporate-dashboard look the system exists
       * to avoid.
       */}
      <ScreenShell
        measure="reading"
        onScroll={handleDetailScroll}
        scrollEventThrottle={16}
        testID="detail-shell"
      >
        <View testID="detail-surface">{detailContent}</View>
      </ScreenShell>

      {authoritativeActivity === undefined ? null : (
        <>
          <SnoozeSheet
            open={snoozeOpen}
            item={snoozeItem}
            currentMinute={currentMinute}
            onClose={() => setSnoozeOpen(false)}
            onSnooze={(_item, until) => {
              if (shownSchedule === undefined) return;
              void actions.snooze(
                actionScope,
                until,
                // The day the row is rendered on, which an override can move off the nominal.
                shownSchedule.date,
              );
            }}
            /**
             * **`Tomorrow` is a reschedule, not a snooze** (§5.3): moving a one-off task to
             * another day *is* one, so it goes through the same schedule write the reschedule
             * sheet uses rather than a second path. P2-25's table omits it on a recurring
             * occurrence, so the sheet never offers it there and this cannot fire for a series.
             */
            onTomorrow={() => {
              if (shownSchedule === undefined) return;
              void detail.schedule({
                date: addWallDays(shownSchedule.date, 1),
                ...(shownSchedule.time === undefined ? {} : { time: shownSchedule.time }),
                timezone:
                  authoritativeActivity.schedule?.timezone ??
                  Intl.DateTimeFormat().resolvedOptions().timeZone,
              });
              setSnoozeOpen(false);
            }}
          />

          <RescheduleSheet
            open={rescheduleOpen}
            onClose={() => setRescheduleOpen(false)}
            today={today}
            activity={authoritativeActivity}
            /**
             * **Occurrence scope reaches the sheet, or the write is rejected.**
             *
             * `scheduleOccurrence` requires an `occurrenceDate` whenever the activity has a
             * recurrence — without one it throws `A recurring occurrence date is required`,
             * which the error middleware renders as "The request was not valid". The sheet
             * already forwards the prop into its payload; this screen was the only caller not
             * supplying it, so changing the time of one day of a series failed here while the
             * same edit from a Today row succeeded.
             */
            {...(actionOccurrenceDate === undefined
              ? {}
              : { occurrenceDate: actionOccurrenceDate })}
            {...(shownSchedule === undefined
              ? {}
              : {
                  renderedDate: shownSchedule.date,
                  ...(shownSchedule.time === undefined
                    ? {}
                    : { renderedTime: shownSchedule.time }),
                })}
            onSchedule={detail.schedule}
            onPatch={detail.patch}
            {...(actionOccurrenceDate === undefined ||
            detail.detail?.capabilities?.skip !== true
              ? {}
              : {
                  /**
                   * `Skip this occurrence` is the removal action for a day of a series (P2-42):
                   * there is no date to clear, and dropping the day is a skip. It reuses the
                   * same one-`OCC#`-row write the delete sheet's `This occurrence` makes.
                   */
                  onSkipOccurrence: skipToday,
                })}
            busy={detail.isSaving}
            {...(detail.editError === undefined ? {} : { error: detail.editError })}
          />
          {authoritativeActivity.schedule === undefined ? null : (
            <RepeatSheet
              open={repeatOpen}
              onClose={() => setRepeatOpen(false)}
              anchorDate={
                authoritativeActivity.recurrence === undefined
                  ? authoritativeActivity.schedule.date
                  : (actionOccurrenceDate ?? today)
              }
              scope={actionScope}
              {...(authoritativeActivity.recurrence === undefined
                ? {}
                : { value: authoritativeActivity.recurrence })}
              onCommit={commitRecurrence}
              {...(actionOccurrenceDate === undefined
                ? {}
                : {
                    onConvertToOneOff: async () => {
                      const converted =
                        await detail.convertToOneOff(actionOccurrenceDate);
                      if (converted) onOpenActivity(activityId);
                      return converted;
                    },
                  })}
              completedOccurrenceCount={detail.detail?.completedOccurrenceCount ?? 0}
              busy={detail.isSaving}
              {...(detail.editError === undefined ? {} : { error: detail.editError })}
            />
          )}
          <ReminderSheet
            open={remindersOpen}
            onClose={() => setRemindersOpen(false)}
            reminders={detail.detail?.reminders ?? []}
            timed={authoritativeActivity.schedule?.time !== undefined}
            busy={detail.isSavingReminder}
            {...(detail.reminderError === undefined
              ? {}
              : { error: detail.reminderError })}
            onAdd={detail.addReminder}
            onRemove={detail.removeReminder}
          />

          <OverflowMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            activity={authoritativeActivity}
            onChangePlanKind={() => setKindSheet('planKind')}
            onChangeObject={() => {
              if (authoritativeActivity.objectKind === 'task') {
                setKindSheet('toPlan');
                return;
              }
              // Plan → Task needs no kind chosen; the menu already checked the blockers.
              propose(authoritativeActivity, { objectKind: 'task', type: 'task' });
            }}
            onDuplicate={() => void duplicate()}
            onDelete={() => setDeleteOpen(true)}
          />

          <ChangeKindSheet
            open={kindSheet !== undefined}
            onClose={() => setKindSheet(undefined)}
            title={kindSheet === 'toPlan' ? 'Change to Plan' : 'Change Plan kind'}
            {...(kindSheet === 'planKind' && authoritativeActivity.objectKind === 'plan'
              ? { current: authoritativeActivity.type as PlanType }
              : {})}
            onChoose={(type) => {
              setKindSheet(undefined);
              propose(authoritativeActivity, { objectKind: 'plan', type });
            }}
          />

          {/**
           * One dialog for both destructive paths, because `interaction-contract.md` §1a.1 is
           * one shape — "a feature spec may point at this section; it may not restate it
           * differently."
           */}
          {pending === undefined ? null : (
            <ConfirmDialog
              open
              confirmation={pending.confirmation}
              busy={detail.isSaving}
              onCancel={() => setPending(undefined)}
              onConfirm={() => void applyKind(authoritativeActivity, pending.target)}
              testID="kind-change-confirm"
            />
          )}

          {authoritativeActivity.recurrence === undefined ? (
            <ConfirmDialog
              open={deleteOpen}
              confirmation={deleteConfirmation(
                authoritativeActivity,
                detail.detail?.reminders.length ?? 0,
              )}
              busy={actions.isBusy}
              onCancel={() => setDeleteOpen(false)}
              onConfirm={() => void remove()}
              testID="delete-confirm"
            />
          ) : (
            <>
              <Sheet
                open={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                title="Delete recurring activity"
                detent="fit"
                actions={
                  <Button
                    label="Cancel"
                    variant="ghost"
                    fullWidth
                    onPress={() => setDeleteOpen(false)}
                  />
                }
                testID="recurring-delete-choices"
              >
                <Text variant="body" color="textSecondary">
                  Choose whether to remove one occurrence, stop future occurrences, or
                  delete the whole series.
                </Text>
                {actionOccurrenceDate === undefined ? (
                  <Text accessibilityRole="alert" color="textSecondary">
                    Open a specific occurrence to remove it or end the series on that
                    date.
                  </Text>
                ) : (
                  <>
                    <Button
                      label="This occurrence"
                      variant="secondary"
                      fullWidth
                      loading={actions.isBusy}
                      onPress={() => void removeOccurrence()}
                      testID="delete-this-occurrence"
                    />
                    <Button
                      label="End series"
                      variant="secondary"
                      fullWidth
                      loading={detail.isSaving}
                      onPress={() => void endSeriesFromDelete()}
                      testID="delete-end-series"
                    />
                  </>
                )}
                <Button
                  label="Delete whole series"
                  variant="danger"
                  fullWidth
                  onPress={() => {
                    setDeleteOpen(false);
                    setDeleteSeriesConfirmOpen(true);
                  }}
                  testID="delete-whole-series"
                />
              </Sheet>

              <ConfirmDialog
                open={deleteSeriesConfirmOpen}
                confirmation={deleteConfirmation(
                  authoritativeActivity,
                  detail.detail?.reminders.length ?? 0,
                  detail.detail?.completedOccurrenceCount ?? 0,
                )}
                busy={actions.isBusy}
                onCancel={() => setDeleteSeriesConfirmOpen(false)}
                onConfirm={() => void remove()}
                testID="delete-series-confirm"
              />
            </>
          )}

          <PassedPlanResolutionSheet
            open={resolutionOpen && showResolutionPrompt}
            type={authoritativeActivity.type}
            title={authoritativeActivity.title}
            busy={actions.isBusy}
            onClose={() => setResolutionOpen(false)}
            onResolve={(outcome) => {
              setResolutionOpen(false);
              /**
               * The chosen outcome travels with the projection. Without it `Didn't go` was
               * projected as a plain completion and the screen answered `Attended` — the
               * opposite of what the user had just tapped — until a refetch corrected it.
               */
              actions.resolvePassed(outcome, actionScope, (resolved) =>
                projectResolution(
                  resolved,
                  isNegativeOutcome(outcome) ? 'skipped' : 'completed',
                  outcome,
                ),
              );
            }}
          />
        </>
      )}
    </View>
  );
}

interface LoadedProps {
  /** The create has not been acknowledged, so the server knows nothing about this row. */
  pending: boolean;
  pendingNeedsAttention: boolean;
  canCancelPending: boolean;
  onCancelPending: () => void;
  cancellingPending: boolean;
  activity: Activity | PendingActivity;
  detail: ReturnType<typeof useActivityDetail>;
  today: WallDate;
  /** Opens a prep child's own detail (P3-37); the child is an ordinary Activity. */
  onOpenChild: (activityId: string) => void;
  /** Complete or uncomplete one Prep task through the platform action owner. */
  onToggleChild: (child: ActivityChild, completed: boolean) => Promise<boolean>;
  /** A public action failed after the detail loaded; keep it visible and retryable in place. */
  actionErrorMessage?: string;
  actionErrorRequestId?: string;
  onRetryAction?: () => void;
  onDismissActionError?: () => void;
  /** Screen-owned near-end scroll events that drive Updates cursor pagination. */
  updatesPaginationSignal: number;
  /** Opens one of this Plan's Lists (P3-37, P3-39). Absent leaves the rows plain. */
  onOpenList?: (listId: string) => void;
  /** `+ Add prep task` (P3-38); absent leaves the chip and the affordance out. */
  onAddPrepTask?: () => void;
  /** `+ Add list` (P3-39); absent leaves the chip and the affordance out. */
  onAddList?: (planTitle: string) => void;
  onOpenReschedule: () => void;
  onOpenRepeat: () => void;
  onOpenReminders: () => void;
  showResolutionPrompt: boolean;
  resolved: boolean;
  onOpenResolution: () => void;
  /**
   * The schedule the screen is about: the occurrence's when one is in scope, the Activity's
   * otherwise. Passed in rather than read from `activity`, which only ever knows the series.
   */
  shownSchedule: { date: string; time?: string; endTime?: string } | undefined;
  /** Server-authored. The client never re-derives ownership (`today-and-tasks.md` §4.1). */
  canComplete: boolean;
  /**
   * Client-side scope/date eligibility, not ownership: a series with no selected day and a
   * generated future occurrence cannot start completion. This suppresses only the primary
   * action, so Undo still reaches already-resolved compatibility data.
   */
  completionUnavailable: boolean;
  completing: boolean;
  undoing: boolean;
  /** Which outcome the resolved state is showing; a skip reverses differently from a done. */
  resolutionKind: ResolutionKind;
  /** The stored or optimistic outcome, so a declined one reports the words the user chose. */
  resolutionOutcome: ActivityOutcome | undefined;
  /** The two occurrence actions, each gated on its own server-authored capability (P2-47). */
  canSnooze: boolean;
  canSkip: boolean;
  /** Whether the skip drops one day of a series, rather than the activity itself. */
  skipsOneDay: boolean;
  onComplete: () => void;
  onSnooze: () => void;
  onSkip: () => void;
  onUndoResolution: () => void;
}

/**
 * Every status that means "this is already resolved", **including the occurrence variants**.
 *
 * An Activity's own status is only ever `completed`/`skipped`; an *occurrence* read back from
 * the agenda is `completed_occurrence`/`skipped_occurrence` (`agenda.ts`). Checking only the
 * first pair meant leaving a completed occurrence and returning to it showed the completion
 * button again, because the cached agenda's answer was true but unrecognised. `AgendaRow` has
 * always matched all four; this set had two.
 */
const RESOLVED_STATUSES = new Set([
  'completed',
  'completed_occurrence',
  'skipped',
  'skipped_occurrence',
]);

/** The subset of the above that means "deliberately not done", rather than done. */
const SKIPPED_STATUSES = new Set(['skipped', 'skipped_occurrence']);

/**
 * What the resolved block says and how it reads.
 *
 * Three states, not two. A **completion** is the type's own verb in the success tone. A
 * **declined outcome** — `Didn't go`, `Didn't happen` — is the user's own words back, and is
 * stored as `status: 'skipped'` with that outcome, which is why it cannot be told apart from a
 * plain skip by status alone. A bare **skip** has no outcome at all: nothing was declared about
 * how it went, only that it is not happening today.
 */
type ResolutionKind = 'completed' | 'skipped';

function Loaded({
  activity,
  detail,
  today,
  onOpenChild,
  onToggleChild,
  actionErrorMessage,
  actionErrorRequestId,
  onRetryAction,
  onDismissActionError,
  updatesPaginationSignal,
  onOpenList,
  onAddPrepTask,
  onAddList,
  onOpenReschedule,
  onOpenRepeat,
  onOpenReminders,
  showResolutionPrompt,
  resolved,
  onOpenResolution,
  shownSchedule,
  canComplete,
  completionUnavailable,
  completing,
  undoing,
  resolutionKind,
  resolutionOutcome,
  pending,
  pendingNeedsAttention,
  canCancelPending,
  onCancelPending,
  cancellingPending,
  canSnooze,
  canSkip,
  skipsOneDay,
  onComplete,
  onSnooze,
  onSkip,
  onUndoResolution,
}: LoadedProps) {
  const theme = useTheme();
  /** The viewer's zone, for stamping update instants onto the viewer's own calendar days. */
  const timezone = resolveViewerTimezone(useQueryClient());
  /**
   * The reconciled §2.1 rule (P3-37): sections exist only once they hold something, so the
   * section list is a function of the loaded content. A pending or offline read carries no
   * collections, which correctly renders settings, `People · Coming later` and nothing else.
   */
  const children = detail.detail?.children ?? [];
  const sourceLists = detail.detail?.sourceLists ?? [];
  const attachments = detail.detail?.attachments ?? [];
  /**
   * The live feed over the embedded first page (P3-40): optimistic posts, deletes and the
   * cursor continuation, reconciled against whatever page the next detail refetch embeds.
   */
  const feed = useActivityUpdates(activity.activityId, {
    updates: detail.detail?.updates,
    cursor: detail.detail?.updatesCursor,
  });
  const updateCount = feed.updates.length + feed.pending.length;
  /**
   * Both operands of the relative stamp in the **same** frame: the instant converts through
   * the viewer's zone, so `today` must be that zone's wall date too — the screen's `today`
   * prop is the device zone's, which differs for a traveller. Read from the injected clock
   * per render rather than a second always-on minute ticker (the screen's own ticker stays
   * gated to the snooze sheet): a stamp only changes at the viewer's midnight, and any
   * re-render after it recomputes; memoised per `createdAt` below.
   */
  const clock = useClock();
  const updatesToday = toWallDate(clock.now(), timezone);
  const updateStamps = useMemo(() => {
    const stamps = new Map<string, string>();
    for (const update of feed.updates) {
      if (!stamps.has(update.createdAt)) {
        stamps.set(
          update.createdAt,
          relativeUpdateTime(update.createdAt, updatesToday, timezone),
        );
      }
    }
    return stamps;
  }, [feed.updates, updatesToday, timezone]);
  const sections = sectionsFor(activity, {
    childCount: children.length,
    sourceListCount: sourceLists.length,
    attachmentCount: attachments.length,
    updateCount,
  });
  const chips = addToPlanChips({
    children,
    sourceLists,
    wired: {
      prepTask: onAddPrepTask !== undefined,
      list: onAddList !== undefined,
    },
  });

  return (
    <View style={{ gap: theme.space[6] }} testID="detail-content">
      {/**
       * The explanation, above everything it explains (§5.4, §5.5).
       *
       * Cancel appears only while the intent is `queued`. Once it is `in_flight` the request
       * is on the wire and cannot be retracted, so offering the button would promise something
       * the client cannot deliver — the sentence changes with it rather than the button going
       * quietly grey.
       */}
      {pending ? (
        <PendingNotice
          message={
            canCancelPending
              ? `This ${activity.objectKind} is saved on this device and waiting to sync. You can cancel it before syncing starts.`
              : pendingNeedsAttention
                ? `This ${activity.objectKind} couldn’t sync. Use Retry or Discard in the message at the top of the screen.`
                : `This ${activity.objectKind} is syncing now. Its actions will appear when syncing finishes.`
          }
          busy={cancellingPending}
          {...(canCancelPending ? { onCancel: onCancelPending } : {})}
        />
      ) : null}
      {actionErrorMessage === undefined ? null : (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="detail-action-error"
          style={{
            gap: theme.space[2],
            padding: theme.space[5],
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.warningSurface,
          }}
        >
          <Text variant="subhead" color="textPrimary">
            {actionErrorMessage}
          </Text>
          {actionErrorRequestId === undefined ? null : (
            <Text
              variant="footnote"
              color="textSecondary"
              selectable
              testID="detail-action-error-request-id"
            >
              {actionErrorRequestId}
            </Text>
          )}
          <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
            {onRetryAction === undefined ? null : (
              <Button
                label="Try again"
                variant="ghost"
                onPress={onRetryAction}
                testID="detail-action-error-retry"
              />
            )}
            {onDismissActionError === undefined ? null : (
              <Button
                label="Dismiss"
                variant="ghost"
                onPress={onDismissActionError}
                testID="detail-action-error-dismiss"
              />
            )}
          </View>
        </View>
      )}
      {detail.conflict === undefined ? null : (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="detail-conflict"
          style={{
            gap: theme.space[2],
            padding: theme.space[5],
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.warningSurface,
          }}
        >
          <Text variant="subhead" color="textPrimary">
            {detail.conflict.message}
          </Text>
          {detail.conflict.dropped === undefined ? null : (
            <Text variant="footnote" color="textSecondary">
              {detail.conflict.dropped}
            </Text>
          )}
          <Button
            label="Review"
            variant="ghost"
            onPress={detail.acknowledgeConflict}
            testID="detail-conflict-review"
          />
        </View>
      )}

      <View style={{ gap: theme.space[5] }} testID="detail-header">
        {/** Title and type/audience are one header unit, not two unrelated form rows. */}
        <View style={{ gap: theme.space[2] }}>
          {pending ? (
            <Text variant="display" color="textPrimary" testID="detail-title">
              {activity.title}
            </Text>
          ) : (
            <InlineText
              label="Title"
              value={activity.title}
              hideLabel
              appearance="bare"
              textVariant="display"
              onCommit={async (title) => {
                await detail.patch({ title });
              }}
              testID="detail-title"
            />
          )}
          <Text variant="subhead" color="textSecondary" testID="detail-subtitle">
            {subtitleFor(
              activity,
              activity.objectKind === 'plan' ? planKindLabel(activity.type) : '',
            )}
          </Text>

          {detail.editError === undefined ? null : (
            <Text variant="footnote" color="danger" testID="detail-edit-error">
              {detail.editError}
            </Text>
          )}
        </View>

        {/** U4: the schedule remains a tap target and never becomes an inline field. */}
        <WhenWhereBlock
          schedule={shownSchedule}
          location={activity.location}
          reminders={detail.detail?.reminders ?? []}
          {...(activity.schedule === undefined
            ? {}
            : activity.recurrence === undefined
              ? {}
              : {
                  recurrenceDescription: describeRecurrence(activity.recurrence, today),
                })}
          today={today}
          onPressDate={pending ? undefined : onOpenReschedule}
          onPressAddress={
            activity.location === undefined
              ? undefined
              : () => void openInMaps(activity.location)
          }
        />

        {/**
         * A passed-plan prompt replaces the primary action in the same visual position — so it
         * carries the primary action's anatomy too. As a `Chip` it was `radius.pill`,
         * `footnote` and `surfaceSunken` at hug width: a passed plan's only offer was a small
         * grey pill under the schedule, which §7.5 does not put at the top of a screen.
         */}
        {showResolutionPrompt ? (
          <Button
            label={passedPlanResolution(activity.type).prompt}
            accessibilityLabel={`${passedPlanResolution(activity.type).prompt} Choose an outcome for ${activity.title}`}
            fullWidth
            size="lg"
            radius="md"
            onPress={onOpenResolution}
            testID="detail-resolution-prompt"
          />
        ) : null}

        {/** One type-derived completion component and position for both object kinds. */}
        {canComplete && !completionUnavailable && !resolved && !showResolutionPrompt ? (
          <Button
            label={completionVerb(activity.type)}
            fullWidth
            size="lg"
            radius="md"
            loading={completing}
            onPress={onComplete}
            testID="detail-complete"
          />
        ) : null}

        {/**
         * **The two occurrence actions, beneath the primary and at its width** (P2-47).
         *
         * They are secondary because completing is what the screen is for, and three equal
         * buttons make the user read all three to find the one they came for. They are still
         * full-size and side by side rather than buried in the `⋯` menu: a snooze is an ordinary
         * daily action, and the founder's report was that reaching it took too long. Each is
         * gated on its own server-authored capability, so a shared plan the user does not own
         * shows neither — and so does a series with no day in context, which has no occurrence
         * to act on.
         */}
        {(canSnooze || canSkip) && !resolved && !showResolutionPrompt ? (
          <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
            {canSnooze ? (
              <View style={{ flex: 1 }}>
                <Button
                  label="Snooze"
                  variant="secondary"
                  size="lg"
                  fullWidth
                  radius="md"
                  onPress={onSnooze}
                  testID="detail-snooze"
                />
              </View>
            ) : null}
            {canSkip ? (
              <View style={{ flex: 1 }}>
                {/**
                 * **`Skip today` only when there is a today to skip** (founder, 2026-08-15).
                 * The label came from P2-47, where it always meant one day of a series; on a
                 * one-off it promised a day scope the write does not have — `POST /skip` with no
                 * occurrence sets `status: 'skipped'` on the Activity, permanently — and on an
                 * undated task it named a day the task was never on. Copy follows the object,
                 * the same rule the reschedule sheet's removal action follows.
                 */}
                <Button
                  label={skipsOneDay ? 'Skip today' : 'Skip'}
                  variant="secondary"
                  size="lg"
                  fullWidth
                  radius="md"
                  onPress={onSkip}
                  testID="detail-skip"
                />
              </View>
            ) : null}
          </View>
        ) : null}

        {/**
         * The outcome is stated before the control that reverses it, not after it — and a skip
         * is stated as a skip.
         *
         * **A skip is not a success and does not read as one.** It used to render the same
         * green line as a completion, one word, easy to miss on a screen that otherwise looks
         * unchanged; the founder's report was that a skipped activity needs to be obvious. It
         * now sits in its own panel, says what it means for the series, and its reversal is
         * `Undo skip` — the label the gesture table already gives this exact action
         * (`interaction-contract.md` §3.1), not the completion's `Undo`.
         */}
        {resolved ? (
          <View
            style={{
              gap: theme.space[3],
              padding: theme.space[5],
              borderRadius: theme.radius.md,
              backgroundColor:
                resolutionKind === 'skipped'
                  ? theme.colors.surfaceSunken
                  : theme.colors.successSurface,
            }}
            testID="detail-resolution"
          >
            <View style={{ gap: theme.space[1] }}>
              {/**
               * **`textMuted` for a declined outcome, `success` for a completed one** (founder,
               * 2026-08-15). A skip and a `Didn't go` are not achievements and stopped reading
               * as one the moment they shared the completion's green; muted is the same token
               * the skipped row on Today now uses, so the two surfaces agree.
               */}
              <Text
                variant="bodyStrong"
                color={resolutionKind === 'skipped' ? 'textMuted' : 'success'}
                testID="detail-resolved"
              >
                {resolutionKind === 'skipped'
                  ? // The user's own words when they chose them; `Skipped` when they did not.
                    resolutionOutcome === undefined
                    ? 'Skipped'
                    : outcomeVerb(activity.type, resolutionOutcome)
                  : outcomeVerb(activity.type, resolutionOutcome)}
              </Text>
              {/**
               * The second line explains a **skip** — what happens to the day and to the
               * series. A declined outcome needs no explaining: `Didn't go` is already the
               * whole statement, and following it with "it won't appear on your day" reads as
               * a consequence being announced rather than an answer being recorded.
               */}
              {resolutionKind === 'skipped' && resolutionOutcome === undefined ? (
                <Text variant="footnote" color="textMuted">
                  {activity.recurrence === undefined
                    ? 'It won’t appear on your day.'
                    : 'This day only. The series carries on.'}
                </Text>
              ) : null}
            </View>
            {canComplete ? (
              <Button
                /**
                 * `Undo skip` is §3.1's label for reversing a **skip**. A declined outcome is
                 * stored the same way but is not one: the user answered a question, and the
                 * reversal of an answer is `Undo`.
                 */
                label={
                  resolutionKind === 'skipped' && resolutionOutcome === undefined
                    ? 'Undo skip'
                    : 'Undo'
                }
                variant="secondary"
                size="lg"
                fullWidth
                radius="md"
                loading={undoing}
                onPress={onUndoResolution}
                testID="detail-undo"
              />
            ) : null}
          </View>
        ) : null}
      </View>

      {/**
       * Capabilities and the bottom time action are **one ruled list**. They were two blocks
       * with a gap between them, and since every row carries its own rule that rendered as two
       * horizontal lines with an empty band trapped between — which reads as a mistake rather
       * than as a grouping. Each row closes itself with a bottom rule, per the frames.
       */}
      <RowGroup testID="detail-sections">
        {sections.map((section) => {
          if (section.key === 'whenWhere') return null;
          /** Content sections render below the ruled settings group, in anatomy order. */
          if (
            section.key === 'prep' ||
            section.key === 'lists' ||
            section.key === 'attachments' ||
            section.key === 'updates'
          ) {
            return null;
          }

          /** Reminder and Repeat are setting rows: value on the right, sheet on tap. */
          if (section.key === 'reminders') {
            return (
              <SettingRow
                key={section.key}
                label={
                  activity.objectKind === 'plan' && activity.visibility === 'shared'
                    ? 'Your reminders'
                    : 'Reminder'
                }
                value={
                  /**
                   * A reminder on a pending activity states its **true** armed state (§5.4).
                   * P2-57 schedules the client-minted reminder locally before the create
                   * reaches the server, so the copy names both that local truth and the
                   * outstanding sync instead of promising server acknowledgement.
                   */
                  pending && (detail.detail?.reminders.length ?? 0) > 0
                    ? 'Armed on this device · waiting to sync'
                    : reminderSummary(
                        detail.detail?.reminders ?? [],
                        activity.schedule?.time !== undefined,
                      )
                }
                {...(pending ? {} : { onPress: onOpenReminders })}
                testID="section-reminders"
              />
            );
          }

          if (section.key === 'repeat') {
            return (
              <SettingRow
                key={section.key}
                label="Repeat"
                value={
                  activity.recurrence === undefined
                    ? 'Does not repeat'
                    : describeRecurrence(activity.recurrence, today)
                }
                {...(pending ? {} : { onPress: onOpenRepeat })}
                testID="detail-edit-recurrence"
              />
            );
          }

          if (section.key === 'notes') {
            return (
              <DisclosureRow
                key={section.key}
                label="Notes"
                summary={
                  activity.notes?.trim() === '' || activity.notes === undefined
                    ? 'Add notes'
                    : activity.notes
                }
                testID="section-notes"
              >
                {pending ? (
                  <Text variant="body" color="textSecondary" testID="detail-notes">
                    {activity.notes?.trim() === '' || activity.notes === undefined
                      ? 'No notes'
                      : activity.notes}
                  </Text>
                ) : (
                  <InlineText
                    label="Notes"
                    value={activity.notes ?? ''}
                    hideLabel
                    appearance="bare"
                    multiline
                    placeholder="Add notes"
                    onCommit={async (notes) => {
                      await detail.patch({ notes });
                    }}
                    testID="detail-notes"
                  />
                )}
              </DisclosureRow>
            );
          }

          if (section.state === 'coming-later') {
            // Attachments' discovery row belongs at its §2.1 slot (section 8, after
            // Lists), not among the settings rows — rendered in the lower stack below.
            if (section.key === 'attachments-coming-later') return null;
            return (
              <SettingRow
                key={section.key}
                label={section.label ?? ''}
                summary={section.summary ?? ''}
                note="Coming later"
                testID={`section-${section.key}`}
              />
            );
          }

          // Related plan — the parent link on a prep task (`today-and-tasks.md` §5.5).
          return (
            <DisclosureRow
              key={section.key}
              label="Related plan"
              summary={
                activity.parentActivityId === undefined ? 'None' : 'Part of a plan'
              }
              testID="section-related"
            >
              <Text variant="body" color="textSecondary">
                {activity.parentActivityId === undefined
                  ? 'A related plan appears here when this task is added from a plan.'
                  : 'This task is part of a plan.'}
              </Text>
            </DisclosureRow>
          );
        })}
      </RowGroup>

      {/**
       * The content sections (P3-37, §2.1 amended): each exists only because `sectionsFor`
       * said its collection is populated, in the anatomy's fixed order, followed by the one
       * `Add to this plan` chip row that keeps the empty capabilities discoverable.
       */}
      {sections.some((section) => section.key === 'prep') ? (
        <PrepSection
          prepTasks={children}
          onOpenChild={onOpenChild}
          {...(pending ? {} : { onToggleChild })}
          {...(onAddPrepTask === undefined || pending ? {} : { onAddPrepTask })}
        />
      ) : null}
      {sections.some((section) => section.key === 'lists') && onOpenList !== undefined ? (
        <ListsSection
          sourceLists={sourceLists}
          onOpenList={onOpenList}
          {...(onAddList === undefined || pending
            ? {}
            : { onAddList: () => onAddList(activity.title) })}
        />
      ) : null}
      {sections.some((section) => section.key === 'attachments-coming-later') ? (
        // RowGroup, never a naked SettingRow: rows own their bottom hairline, and a bare
        // one draws an orphaned rule between two framed sections (RowGroup's own warning).
        <RowGroup>
          <SettingRow
            label="Attachments"
            summary="Photos and files"
            note="Coming later"
            testID="section-attachments-coming-later"
          />
        </RowGroup>
      ) : null}
      {sections.some((section) => section.key === 'attachments') ? (
        <AttachmentsSection attachments={attachments} />
      ) : null}
      {sections.some((section) => section.key === 'updates') ? (
        <UpdatesSection
          updates={feed.updates}
          pending={feed.pending}
          relativeTime={(createdAt) =>
            updateStamps.get(createdAt) ??
            relativeUpdateTime(createdAt, updatesToday, timezone)
          }
          {...(pending ? {} : { onPost: feed.post, onDelete: feed.remove })}
          isPosting={feed.isPosting}
          hasOlder={feed.cursor !== undefined}
          onLoadOlder={feed.loadMore}
          isLoadingOlder={feed.isLoadingMore}
          paginationSignal={updatesPaginationSignal}
          {...(feed.errorMessage === undefined
            ? {}
            : {
                errorMessage: feed.errorMessage,
                ...(feed.errorRequestId === undefined
                  ? {}
                  : { errorRequestId: feed.errorRequestId }),
                ...(feed.errorAction === undefined
                  ? {}
                  : { errorAction: feed.errorAction }),
                onRetryError: feed.retryFailure,
              })}
        />
      ) : null}
      {activity.objectKind === 'plan' && !pending ? (
        <AddToPlanRow
          chips={chips}
          {...(onAddPrepTask === undefined ? {} : { onAddPrepTask })}
          {...(onAddList === undefined
            ? {}
            : { onAddList: () => onAddList(activity.title) })}
        />
      ) : null}
    </View>
  );
}

/**
 * A field that commits on blur and on nothing else.
 *
 * The local copy exists so typing does not fight the query cache mid-keystroke; it is
 * re-synced whenever the server's value changes underneath — which is what makes a 409
 * refetch visible in the field rather than being masked by stale local state.
 *
 * **A commit fires only when the trimmed value actually differs.** Without that, tabbing
 * through a form would issue a `PATCH` per field, each one moving `updatedAt` and each one a
 * chance to collide with somebody else's edit.
 */
function InlineText({
  label,
  value,
  onCommit,
  multiline = false,
  placeholder,
  hideLabel = false,
  appearance,
  textVariant,
  testID,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void | Promise<void>;
  multiline?: boolean;
  placeholder?: string;
  hideLabel?: boolean;
  appearance?: 'boxed' | 'bare';
  /** `display` is the detail header's serif title (`design-system.md` §7.5). */
  textVariant?: 'body' | 'title' | 'display';
  testID?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <Field
      label={label}
      value={draft}
      onChangeText={setDraft}
      multiline={multiline}
      hideLabel={hideLabel}
      {...(appearance === undefined ? {} : { appearance })}
      {...(textVariant === undefined ? {} : { textVariant })}
      {...(placeholder === undefined ? {} : { placeholder })}
      onBlur={() => {
        if (draft.trim() === value.trim()) return;
        void onCommit(draft.trim());
      }}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}

/** The patch type is re-exported so the route file does not reach into `@od/shared`. */
export type { PatchActivityInput };
