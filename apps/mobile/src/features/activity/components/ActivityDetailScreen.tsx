import type { ChangeTarget } from '@od/shared';
import { describeRecurrence } from '@od/shared/recurrence';
import type { PatchActivityInput } from '@od/shared/schemas';
import type { Activity, PlanType } from '@od/shared/types';
import {
  Button,
  Card,
  ChevronLeft,
  Chip,
  EmptyState,
  Field,
  IconButton,
  MoreHorizontal,
  Skeleton,
  Text,
  useBreakpoint,
  useTheme,
} from '@od/ui';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PassedPlanResolutionSheet } from '@/components/PassedPlanResolutionSheet';
import { ChangeKindSheet } from '@/features/activity/components/ChangeKindSheet';
import { ConfirmDialog } from '@/features/activity/components/ConfirmDialog';
import { DetailDisclosureRow } from '@/features/activity/components/DetailDisclosureRow';
import { OverflowMenu } from '@/features/activity/components/OverflowMenu';
import { ReminderDisclosure } from '@/features/activity/components/ReminderDisclosure';
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
import { sectionsFor, subtitleFor } from '@/features/activity/model/sections';
import { completionVerb, passedPlanResolution } from '@/lib/passedPlanResolution';
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
  activityId: string;
  /** The user's today, in their zone. Injected so the quick chips are testable (§4.3). */
  today: WallDate;
  onBack: () => void;
  /** Where a duplicate lands: its own detail screen (P1-27, `activities.md` §7.1). */
  onOpenActivity: (activityId: string) => void;
  /** Present only when navigation came from a passed, unresolved agenda row. */
  resolutionOccurrenceDate?: string | null;
  /** The occurrence whose agenda row opened this route, independent of prompt visibility. */
  occurrenceDate?: string;
  /** Keeps the route marker in sync with optimistic resolution, Undo, and request rollback. */
  onResolutionProjectionChange?: (resolved: boolean) => void;
}

/** A kind change waiting on its confirmation. Absent means nothing is being confirmed. */
interface PendingChange {
  target: ChangeTarget;
  confirmation: Confirmation;
}

export function ActivityDetailScreen({
  activityId,
  today,
  onBack,
  onOpenActivity,
  resolutionOccurrenceDate,
  occurrenceDate,
  onResolutionProjectionChange,
}: ActivityDetailScreenProps) {
  const theme = useTheme();
  const breakpoint = useBreakpoint();
  const insets = useSafeAreaInsets();
  const detail = useActivityDetail(activityId);
  const actions = useActivityActions(activityId);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [kindSheet, setKindSheet] = useState<'planKind' | 'toPlan' | undefined>(
    undefined,
  );
  const [pending, setPending] = useState<PendingChange | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [resolutionDismissed, setResolutionDismissed] = useState(false);

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
      onBack();
    }
  }

  const activity = detail.detail?.activity;
  const showResolutionPrompt =
    resolutionOccurrenceDate !== undefined &&
    activity?.status === 'scheduled' &&
    detail.detail?.capabilities?.complete === true &&
    !resolutionDismissed;
  const actionOccurrenceDate = occurrenceDate ?? resolutionOccurrenceDate ?? undefined;

  /** The measure, per §8. `compact` is full width minus the gutters. */
  const maxWidth =
    breakpoint === 'compact' ? undefined : breakpoint === 'medium' ? 720 : 620;
  const framed = breakpoint !== 'compact';

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
          showResolutionPrompt={showResolutionPrompt}
          occurrenceScoped={actionOccurrenceDate !== undefined}
          onOpenResolution={() => setResolutionOpen(true)}
          canComplete={detail.detail?.capabilities?.complete === true}
          completing={actions.isCompleting}
          undoing={actions.isUndoing}
          onComplete={() => {
            actions.resolvePassed(
              passedPlanResolution(activity.type).positive.outcome,
              actionOccurrenceDate,
              (resolved) => {
                setResolutionDismissed(resolved);
                onResolutionProjectionChange?.(resolved);
              },
            );
          }}
          onUndoResolution={() => {
            actions.undoResolution(actionOccurrenceDate);
            setResolutionDismissed(false);
            onResolutionProjectionChange?.(false);
          }}
          onAddReminder={detail.addReminder}
          onRemoveReminder={detail.removeReminder}
        />
      )}
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space[5],
          paddingTop: insets.top + (framed ? theme.space[7] : theme.space[3]),
          paddingBottom: insets.bottom + theme.space[8],
        }}
      >
        <View
          style={{
            width: '100%',
            alignSelf: 'center',
            ...(maxWidth === undefined ? {} : { maxWidth }),
          }}
        >
          {framed ? (
            <Card elevation="e2" radius="xl" padding={7} testID="detail-surface">
              {detailContent}
            </Card>
          ) : (
            <View testID="detail-surface">{detailContent}</View>
          )}
        </View>
      </ScrollView>

      {activity === undefined ? null : (
        <>
          <RescheduleSheet
            open={rescheduleOpen}
            onClose={() => setRescheduleOpen(false)}
            today={today}
            activity={activity}
            onSchedule={detail.schedule}
            onPatch={detail.patch}
            busy={detail.isSaving}
            {...(detail.editError === undefined ? {} : { error: detail.editError })}
          />
          {activity.schedule === undefined ? null : (
            <RepeatSheet
              open={repeatOpen}
              onClose={() => setRepeatOpen(false)}
              anchorDate={
                activity.recurrence === undefined ? activity.schedule.date : today
              }
              {...(activity.recurrence === undefined
                ? {}
                : { value: activity.recurrence })}
              activityForConfirmation={{ title: activity.title }}
              completedOccurrenceCount={detail.detail?.completedOccurrenceCount ?? 0}
              onCommit={(recurrence) => detail.patch({ recurrence: recurrence ?? null })}
              busy={detail.isSaving}
              {...(detail.editError === undefined ? {} : { error: detail.editError })}
            />
          )}
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

          <PassedPlanResolutionSheet
            open={resolutionOpen && showResolutionPrompt}
            type={activity.type}
            title={activity.title}
            busy={actions.isBusy}
            onClose={() => setResolutionOpen(false)}
            onResolve={(outcome) => {
              setResolutionOpen(false);
              actions.resolvePassed(outcome, actionOccurrenceDate, (resolved) => {
                setResolutionDismissed(resolved);
                onResolutionProjectionChange?.(resolved);
              });
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
  showResolutionPrompt: boolean;
  occurrenceScoped: boolean;
  onOpenResolution: () => void;
  /** Server-authored. The client never re-derives ownership (`today-and-tasks.md` §4.1). */
  canComplete: boolean;
  completing: boolean;
  undoing: boolean;
  onComplete: () => void;
  onUndoResolution: () => void;
  onAddReminder: (offsetMinutes: number) => Promise<boolean>;
  onRemoveReminder: (reminderId: string) => Promise<boolean>;
}

const RESOLVED_STATUSES = new Set(['completed', 'skipped']);

function Loaded({
  activity,
  detail,
  today,
  onOpenReschedule,
  onOpenRepeat,
  showResolutionPrompt,
  occurrenceScoped,
  onOpenResolution,
  canComplete,
  completing,
  undoing,
  onComplete,
  onUndoResolution,
  onAddReminder,
  onRemoveReminder,
}: LoadedProps) {
  const theme = useTheme();
  const sections = sectionsFor(activity);
  const resolved = RESOLVED_STATUSES.has(activity.status);

  return (
    <View style={{ gap: theme.space[7] }} testID="detail-content">
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

      <View style={{ gap: theme.space[7] }} testID="detail-header">
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
          schedule={activity.schedule}
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

        {/** A passed-plan prompt replaces the primary action in the same visual position. */}
        {showResolutionPrompt ? (
          <Chip
            label={passedPlanResolution(activity.type).prompt}
            accessibilityLabel={`${passedPlanResolution(activity.type).prompt} Choose an outcome for ${activity.title}`}
            tone="neutral"
            onPress={onOpenResolution}
            testID="detail-resolution-prompt"
          />
        ) : null}

        {/** One type-derived completion component and position for both object kinds. */}
        {canComplete && !resolved && !showResolutionPrompt && !occurrenceScoped ? (
          <Button
            label={completionVerb(activity.type)}
            fullWidth
            size="lg"
            loading={completing}
            onPress={onComplete}
            testID="detail-complete"
          />
        ) : null}

        {resolved ? (
          <View style={{ gap: theme.space[3] }}>
            {canComplete ? (
              <Button
                label="Undo"
                variant="secondary"
                size="lg"
                fullWidth
                loading={undoing}
                onPress={onUndoResolution}
                testID="detail-undo"
              />
            ) : null}
            <Text variant="bodyStrong" color="success" testID="detail-resolved">
              {activity.status === 'skipped' ? 'Skipped' : completionVerb(activity.type)}
            </Text>
          </View>
        ) : null}
      </View>

      <View testID="detail-sections">
        {sections.map((section) => {
          if (section.key === 'whenWhere') return null;

          if (section.key === 'reminders') {
            return (
              <ReminderDisclosure
                key={section.key}
                reminders={detail.detail?.reminders ?? []}
                timed={activity.schedule?.time !== undefined}
                busy={detail.isSavingReminder}
                {...(detail.reminderError === undefined
                  ? {}
                  : { error: detail.reminderError })}
                onAdd={onAddReminder}
                onRemove={onRemoveReminder}
              />
            );
          }

          if (section.key === 'notes') {
            return (
              <DetailDisclosureRow
                key={section.key}
                title="Notes"
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
              </DetailDisclosureRow>
            );
          }

          if (section.state === 'coming-later') {
            return (
              <DetailDisclosureRow
                key={section.key}
                title={section.label ?? ''}
                summary={section.summary ?? ''}
                testID={`section-${section.key}`}
              />
            );
          }

          // Related plan — the parent link on a prep task (`today-and-tasks.md` §5.5).
          return (
            <DetailDisclosureRow
              key={section.key}
              title="Related plan"
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
            </DetailDisclosureRow>
          );
        })}
      </View>

      {activity.schedule === undefined ? null : (
        <View
          style={{
            gap: theme.space[3],
            paddingTop: theme.space[6],
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
          }}
          testID="detail-time-actions"
        >
          <Text variant="caption" color="textSecondary">
            More
          </Text>
          <Button
            label="Edit recurrence"
            variant="ghost"
            onPress={onOpenRepeat}
            testID="detail-edit-recurrence"
          />
        </View>
      )}
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
