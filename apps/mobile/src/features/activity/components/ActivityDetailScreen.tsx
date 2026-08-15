import type { ChangeTarget } from '@od/shared';
import { addWallDays, describeRecurrence } from '@od/shared/recurrence';
import type { PatchActivityInput } from '@od/shared/schemas';
import { type TimeZone, toWallTime } from '@od/shared/time';
import type {
  Activity,
  ActivityDetailTarget,
  ActivityOutcome,
  PlanType,
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
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { PassedPlanResolutionSheet } from '@/components/PassedPlanResolutionSheet';
import { SnoozeSheet } from '@/components/SnoozeSheet';
import { ChangeKindSheet } from '@/features/activity/components/ChangeKindSheet';
import { ConfirmDialog } from '@/features/activity/components/ConfirmDialog';
import { OverflowMenu } from '@/features/activity/components/OverflowMenu';
import {
  ReminderSheet,
  reminderSummary,
} from '@/features/activity/components/ReminderSheet';
import { RepeatSheet } from '@/features/activity/components/RepeatSheet';
import { RescheduleSheet } from '@/features/activity/components/RescheduleSheet';
import { WhenWhereBlock } from '@/features/activity/components/WhenWhereBlock';
import { useActivityDetail } from '@/features/activity/hooks/useActivity';
import {
  kindChangePatch,
  useActivityActions,
} from '@/features/activity/hooks/useActivityActions';
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
import { endRepeatSeries } from '@/features/activity/model/repeat';
import { sectionsFor, subtitleFor } from '@/features/activity/model/sections';
import { useMinuteTicker } from '@/hooks/useMinuteTicker';
import {
  completionVerb,
  isNegativeOutcome,
  outcomeVerb,
  passedPlanResolution,
} from '@/lib/passedPlanResolution';
import { planKindLabel } from '@/lib/planKinds';

/**
 * The Activity detail screen (P1-26).
 *
 * One `GET /v1/activities/:id`, which is one DynamoDB Query. Editing is **in place**: there
 * is no edit mode and no per-field Save button. Text commits on blur, pickers commit on
 * selection, and each issues its own `PATCH` with `If-Match` (`activities.md` §6.1).
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
  resolutionOccurrenceDate,
  onResolutionProjectionChange,
}: ActivityDetailScreenProps) {
  const theme = useTheme();
  const activityId = target.activityId;
  const detail = useActivityDetail(target);
  const actions = useActivityActions(activityId);
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
  const showResolutionPrompt =
    resolutionOccurrenceDate !== undefined &&
    activity?.status === 'scheduled' &&
    detail.detail?.capabilities?.complete === true &&
    !resolutionDismissed;
  /** The server echoes only the explicit nominal occurrence target supplied by navigation. */
  const actionOccurrenceDate = detail.detail?.occurrence?.nominalDate;

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
    if (activity?.recurrence === undefined || actionOccurrenceDate === undefined) return;
    if (
      await detail.patch({
        recurrence: endRepeatSeries(activity.recurrence, actionOccurrenceDate),
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
        {activity === undefined ? null : (
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
          onOpenReschedule={() => setRescheduleOpen(true)}
          onOpenRepeat={() => setRepeatOpen(true)}
          onOpenReminders={() => setRemindersOpen(true)}
          showResolutionPrompt={showResolutionPrompt}
          resolved={resolved}
          onOpenResolution={() => setResolutionOpen(true)}
          shownSchedule={shownSchedule}
          canComplete={detail.detail?.capabilities?.complete === true}
          completionUnavailable={seriesWithoutOccurrence || futureRecurringOccurrence}
          completing={actions.isCompleting}
          undoing={actions.isUndoing}
          resolutionKind={resolutionKind}
          resolutionOutcome={resolutionOutcome}
          canSnooze={canSnoozeOccurrence(occurrenceContext)}
          canSkip={canSkipOccurrence(occurrenceContext)}
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
      <ScreenShell measure="reading">
        <View testID="detail-surface">{detailContent}</View>
      </ScreenShell>

      {activity === undefined ? null : (
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
                  activity.schedule?.timezone ??
                  Intl.DateTimeFormat().resolvedOptions().timeZone,
              });
              setSnoozeOpen(false);
            }}
          />

          <RescheduleSheet
            open={rescheduleOpen}
            onClose={() => setRescheduleOpen(false)}
            today={today}
            activity={activity}
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
          {activity.schedule === undefined ? null : (
            <RepeatSheet
              open={repeatOpen}
              onClose={() => setRepeatOpen(false)}
              anchorDate={
                activity.recurrence === undefined
                  ? activity.schedule.date
                  : (actionOccurrenceDate ?? today)
              }
              scope={actionScope}
              {...(activity.recurrence === undefined
                ? {}
                : { value: activity.recurrence })}
              onCommit={(recurrence) =>
                detail.patch({
                  recurrence: recurrence ?? null,
                  ...(recurrence !== undefined &&
                  activity.recurrence !== undefined &&
                  recurrence.segments.length > activity.recurrence.segments.length &&
                  actionOccurrenceDate !== undefined
                    ? { editedFromDate: actionOccurrenceDate }
                    : {}),
                })
              }
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
            timed={activity.schedule?.time !== undefined}
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
            activity={activity}
            onChangePlanKind={() => setKindSheet('planKind')}
            onChangeObject={() => {
              if (activity.objectKind === 'task') {
                setKindSheet('toPlan');
                return;
              }
              // Plan → Task needs no kind chosen; the menu already checked the blockers.
              propose(activity, { objectKind: 'task', type: 'task' });
            }}
            onDuplicate={() => void duplicate()}
            onDelete={() => setDeleteOpen(true)}
          />

          <ChangeKindSheet
            open={kindSheet !== undefined}
            onClose={() => setKindSheet(undefined)}
            title={kindSheet === 'toPlan' ? 'Change to Plan' : 'Change Plan kind'}
            {...(kindSheet === 'planKind' && activity.objectKind === 'plan'
              ? { current: activity.type as PlanType }
              : {})}
            onChoose={(type) => {
              setKindSheet(undefined);
              propose(activity, { objectKind: 'plan', type });
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
              onConfirm={() => void applyKind(activity, pending.target)}
              testID="kind-change-confirm"
            />
          )}

          {activity.recurrence === undefined ? (
            <ConfirmDialog
              open={deleteOpen}
              confirmation={deleteConfirmation(
                activity,
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
                  activity,
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
            type={activity.type}
            title={activity.title}
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
  activity: Activity;
  detail: ReturnType<typeof useActivityDetail>;
  today: WallDate;
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
  canSnooze,
  canSkip,
  skipsOneDay,
  onComplete,
  onSnooze,
  onSkip,
  onUndoResolution,
}: LoadedProps) {
  const theme = useTheme();
  const sections = sectionsFor(activity);

  return (
    <View style={{ gap: theme.space[6] }} testID="detail-content">
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
          onPressDate={onOpenReschedule}
          onPressAddress={undefined}
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

          /** Reminder and Repeat are setting rows: value on the right, sheet on tap. */
          if (section.key === 'reminders') {
            return (
              <SettingRow
                key={section.key}
                label="Reminder"
                value={reminderSummary(
                  detail.detail?.reminders ?? [],
                  activity.schedule?.time !== undefined,
                )}
                onPress={onOpenReminders}
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
                onPress={onOpenRepeat}
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
              </DisclosureRow>
            );
          }

          if (section.state === 'coming-later') {
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
