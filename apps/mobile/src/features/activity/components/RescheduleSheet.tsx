import type { PatchActivityInput, ScheduleActivityInput } from '@od/shared/schemas';
import type { Activity, RecurrenceSegment } from '@od/shared/types';
import {
  Button,
  Field,
  RowGroup,
  SettingRow,
  Sheet,
  Text,
  TimePicker,
  useTheme,
} from '@od/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ConfirmDialog } from '@/features/activity/components/ConfirmDialog';
import {
  formatQuickDate,
  formatScheduleChange,
  type QuickDate,
  quickDates,
  type WallDate,
} from '@/features/activity/model/dates';

/** The edit the user has committed to, held while the scope question is answered. */
interface PendingEdit {
  date: WallDate;
  time: string | null;
}

export interface RescheduleSheetProps {
  open: boolean;
  onClose: () => void;
  /** Renders only the editor when a coordinator already owns the stable outer sheet. */
  embedded?: boolean;
  /** The user's today, in their zone. Injected so chips and detail edits are deterministic. */
  today: WallDate;
  activity: Activity;
  /** Present only when the sheet was opened from one expanded occurrence. */
  occurrenceDate?: WallDate;
  /** Agenda overrides can make the rendered value differ from the active segment snapshot. */
  renderedDate?: WallDate;
  renderedTime?: string;
  onSchedule: (input: ScheduleActivityInput) => Promise<boolean>;
  onPatch: (input: PatchActivityInput) => Promise<boolean>;
  /**
   * Skips the occurrence in scope. Supplied by the surface that owns the write, so this sheet
   * never acquires a second dispatch path for something Today and detail already do.
   */
  onSkipOccurrence?: () => Promise<boolean>;
  busy?: boolean;
  error?: string;
}

function segmentInForce(
  activity: Activity,
  occurrenceDate: WallDate | undefined,
): RecurrenceSegment | undefined {
  const segments = activity.recurrence?.segments;
  if (segments === undefined) return undefined;
  if (occurrenceDate === undefined) return segments.at(-1);
  return [...segments]
    .reverse()
    .find((segment) => segment.effectiveFrom <= occurrenceDate);
}

function appendedSegment(
  active: RecurrenceSegment,
  effectiveFrom: WallDate,
  time: string | null,
): RecurrenceSegment {
  return {
    freq: active.freq,
    ...(active.interval === undefined ? {} : { interval: active.interval }),
    ...(active.byWeekday === undefined ? {} : { byWeekday: active.byWeekday }),
    ...(active.byMonthDay === undefined ? {} : { byMonthDay: active.byMonthDay }),
    ...(active.byMonth === undefined ? {} : { byMonth: active.byMonth }),
    ...(active.rrule === undefined ? {} : { rrule: active.rrule }),
    // Required by the shared schema, but the server derives and overwrites this value.
    effectiveFrom,
    ...(time === null ? {} : { time }),
    ...(time === null || active.endTime === undefined ? {} : { endTime: active.endTime }),
  };
}

/**
 * The single reschedule surface used by activity detail and agenda rows (U4, P2-26).
 *
 * ## The scope question is asked after the edit, not before it (P2-42)
 *
 * `This occurrence only` / `All future occurrences` used to be the sheet's opening state, so a
 * recurring occurrence asked which occurrences to apply a change to **before the user had made
 * one** — and then showed a different editor depending on the answer, which meant the answer
 * silently decided whether a date could be moved at all. The two options and what each writes
 * are P2-26's and are unchanged; only when the question is asked has moved. It now arrives as
 * an `Apply changes to` step carrying the before→after summary of the edit being scoped.
 *
 * **A date move is not asked about**, because it cannot be answered two ways: an appended rule
 * segment carries a time, not a day (`data-model.md` §4.2), so moving one occurrence to another
 * date is occurrence-scoped by construction and writes the same `overrideDate` P2-26 built.
 * Changing which weekday a series lands on is the Repeat sheet's job, not this one's.
 */
export function RescheduleSheet({
  open,
  onClose,
  embedded = false,
  today,
  activity,
  occurrenceDate,
  renderedDate,
  renderedTime,
  onSchedule,
  onPatch,
  onSkipOccurrence,
  busy = false,
  error,
}: RescheduleSheetProps) {
  const theme = useTheme();
  const recurring = activity.recurrence !== undefined;
  const active = segmentInForce(activity, occurrenceDate);
  const initialDate = renderedDate ?? occurrenceDate ?? activity.schedule?.date ?? today;
  const initialTime = renderedTime ?? active?.time ?? activity.schedule?.time ?? null;
  /** One day of a series is in front of the user, so the series can be edited from it. */
  const scopedOccurrence = recurring && occurrenceDate !== undefined;
  const [pending, setPending] = useState<PendingEdit | undefined>();
  const [picking, setPicking] = useState(false);
  const [typed, setTyped] = useState(initialDate);
  const [pickedTime, setPickedTime] = useState<string | null>(initialTime);
  const [clearConfirmation, setClearConfirmation] = useState(false);
  const [seriesLimit, setSeriesLimit] = useState(false);
  const [seriesOrderError, setSeriesOrderError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setPending(undefined);
    setPicking(false);
    setTyped(initialDate);
    setPickedTime(initialTime);
    setClearConfirmation(false);
    setSeriesLimit(false);
    setSeriesOrderError(undefined);
  }, [initialDate, initialTime, open]);

  const scheduleInput = (date: WallDate, time: string | null): ScheduleActivityInput => ({
    date,
    ...(time === null ? {} : { time }),
    ...(time === null || active?.endTime === undefined
      ? {}
      : { endTime: active.endTime }),
    timezone:
      activity.schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(recurring && occurrenceDate !== undefined ? { occurrenceDate } : {}),
  });

  const commitOccurrence = async (date: WallDate, time: string | null) => {
    if (await onSchedule(scheduleInput(date, time))) onClose();
  };

  const commitFuture = async (time: string | null) => {
    const recurrence = activity.recurrence;
    if (recurrence === undefined || active === undefined) return;
    const anchor = occurrenceDate ?? today;
    const latest = recurrence.segments.at(-1);
    if (latest === undefined) return;
    setSeriesOrderError(undefined);

    /**
     * A segment that already starts today is still provisional: the API deliberately permits
     * replacing that active segment as a same-day correction. Appending another segment with
     * the same date fails the shared schema before any request leaves the device.
     *
     * An older occurrence before the latest segment is different. Recurrence history is
     * append-only, so an all-future edit cannot insert itself before a later change. Keep the
     * edit in the sheet and explain the available path instead of persisting an intent that can
     * never pass validation.
     */
    const sameDayCorrection = anchor === today && latest.effectiveFrom === anchor;
    if (!sameDayCorrection && anchor <= latest.effectiveFrom) {
      setSeriesOrderError(
        'Future schedule changes already start on this date or later. Choose “This occurrence only” or edit a later occurrence.',
      );
      return;
    }
    const next = appendedSegment(active, anchor, time);
    const ok = await onPatch({
      recurrence: {
        ...recurrence,
        segments: sameDayCorrection
          ? [...recurrence.segments.slice(0, -1), next]
          : [...recurrence.segments, next],
      },
      ...(sameDayCorrection || occurrenceDate === undefined
        ? {}
        : { editedFromDate: occurrenceDate }),
    });
    if (ok) {
      onClose();
      return;
    }
    if (recurrence.segments.length >= 20) setSeriesLimit(true);
  };

  /**
   * The commit gesture. Every date option and the time wheel's `Done` arrive here, and this is
   * the one place that decides whether the write goes out or the scope question is asked first.
   */
  const requestCommit = (date: WallDate, time: string | null) => {
    setSeriesOrderError(undefined);
    if (scopedOccurrence && date === initialDate) {
      setPending({ date, time });
      return;
    }
    void commitOccurrence(date, time);
  };

  const choose = (chip: QuickDate) => {
    if (chip.date === undefined) {
      setPicking(true);
      return;
    }
    requestCommit(chip.date, pickedTime);
  };

  const commitTyped = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(typed)) return;
    requestCommit(typed, pickedTime);
  };

  const clearDate = async () => {
    if (await onSchedule({ date: null })) {
      setClearConfirmation(false);
      onClose();
    }
  };

  const skipOccurrence = async () => {
    if (onSkipOccurrence === undefined) return;
    if (await onSkipOccurrence()) onClose();
  };

  /**
   * **Removal language matches the object, not the mechanism.** A Task without a date is still a
   * task and moves to Anytime; a Plan without one goes to Plans → Needs a date; and one day of a
   * series has no date to remove at all — dropping it is a skip (`today-and-tasks.md` §5.4).
   * `Clear the date` described the mechanic for all three and left the user to work out where
   * the thing went.
   */
  const removal = scopedOccurrence
    ? { label: 'Skip this occurrence', hint: 'Keeps the series, drops this day' }
    : activity.objectKind === 'task'
      ? { label: 'Move to Anytime', hint: 'Keeps the task, drops the date' }
      : { label: 'Remove date', hint: 'Moves this plan to “Needs a date”' };

  const removalPress = scopedOccurrence
    ? () => void skipOccurrence()
    : () => {
        if (activity.participantCount > 0) {
          setClearConfirmation(true);
          return;
        }
        void clearDate();
      };

  /**
   * §6's **action row**: the imperative label is itself the affordance, so it takes no chevron.
   * A chevron here would promise navigation this does not do.
   */
  const removalOffered = scopedOccurrence
    ? onSkipOccurrence !== undefined
    : !recurring && activity.schedule !== undefined;

  const removalRow = !removalOffered ? null : (
    <SettingRow
      label={removal.label}
      summary={removal.hint}
      accessibilityLabel={`${removal.label}. ${removal.hint}`}
      onPress={removalPress}
      testID="reschedule-clear"
    />
  );

  /**
   * The `Apply changes to` step (P2-42). It replaces the editor rather than stacking over it,
   * for the reason §6.1 gives the sheet one surface: a second modal on top of an open one is
   * two dismissal gestures and two `Close` buttons for one decision.
   */
  const scopeSummary =
    pending === undefined
      ? undefined
      : formatScheduleChange({ date: initialDate, time: initialTime }, pending, today);

  const scopeStep =
    pending === undefined ? null : (
      <View style={{ gap: theme.space[5] }} testID="reschedule-scope">
        <View style={{ gap: theme.space[2] }}>
          <Text variant="heading" color="textDisplay" accessibilityRole="header">
            Apply changes to
          </Text>
          {scopeSummary === undefined ? null : (
            <Text
              variant="subhead"
              color="textSecondary"
              testID="reschedule-scope-summary"
            >
              {scopeSummary}
            </Text>
          )}
        </View>

        {/**
         * No summary line on either row, and that is deliberate: the accessible name of the
         * choice stays the choice. `This occurrence only, only Wed Aug 12` reads as a sentence
         * about a date the line above already gave, and P2-26's dispatch tests name these two
         * strings exactly because they are the copy `activities.md` §6.2 fixes.
         */}
        <RowGroup>
          <SettingRow
            label="This occurrence only"
            onPress={() => void commitOccurrence(pending.date, pending.time)}
            testID="reschedule-this-occurrence"
          />
          <SettingRow
            label="All future occurrences"
            onPress={() => void commitFuture(pending.time)}
            testID="reschedule-all-future"
          />
        </RowGroup>

        {seriesLimit ? (
          <View style={{ gap: theme.space[2] }} testID="reschedule-series-limit">
            <Text accessibilityRole="alert" color="danger" numberOfLines={0}>
              This series already has 20 schedule changes. End this series and start a new
              one to keep its history intact.
            </Text>
            <Text variant="subhead" color="textSecondary">
              Use End series from the activity menu, then create a new series.
            </Text>
          </View>
        ) : (seriesOrderError ?? error) === undefined ? null : (
          <Text accessibilityRole="alert" color="danger">
            {seriesOrderError ?? error}
          </Text>
        )}
      </View>
    );

  const editor = (
    <>
      {pending !== undefined ? (
        scopeStep
      ) : recurring && !scopedOccurrence ? (
        <View style={{ gap: theme.space[5] }} testID="reschedule-future-editor">
          <Text variant="subhead" color="textSecondary">
            Future dates keep their repeat pattern. Change the time from this point on.
          </Text>
          <TimePicker
            label="Time"
            value={pickedTime}
            onChange={setPickedTime}
            onConfirm={(value) => void commitFuture(value)}
            openAt={initialTime ?? '09:00'}
            minuteInterval={5}
            allowClear={false}
            presentation="inline"
            testID="reschedule-time-picker"
          />
          {seriesLimit ? (
            <View style={{ gap: theme.space[2] }} testID="reschedule-series-limit">
              <Text accessibilityRole="alert" color="danger" numberOfLines={0}>
                This series already has 20 schedule changes. End this series and start a
                new one to keep its history intact.
              </Text>
              <Text variant="subhead" color="textSecondary">
                Use End series from the activity menu, then create a new series.
              </Text>
            </View>
          ) : (seriesOrderError ?? error) === undefined ? null : (
            <Text accessibilityRole="alert" color="danger">
              {seriesOrderError ?? error}
            </Text>
          )}
        </View>
      ) : (
        <View style={{ gap: theme.space[5] }} testID="reschedule-occurrence-editor">
          {/**
           * **The resolved date sits on the trailing edge of its own label** (P2-42). As a chip
           * row, `Saturday` was a shortcut the user had to decode before committing to it; as a
           * two-part row it commits to a date it has already shown them.
           */}
          <RowGroup>
            {quickDates(today).map((chip) => (
              <SettingRow
                key={chip.key}
                label={chip.label}
                {...(chip.date === undefined
                  ? { opens: true }
                  : { value: formatQuickDate(chip.date, today) })}
                selected={chip.date !== undefined && chip.date === initialDate}
                onPress={() => choose(chip)}
                testID={`quick-date-${chip.key}`}
              />
            ))}
          </RowGroup>

          {picking ? (
            <View style={{ gap: theme.space[3] }}>
              <Field
                label="Date"
                value={typed}
                onChangeText={setTyped}
                placeholder="YYYY-MM-DD"
                hint="v1 has no calendar grid — type the date."
                testID="reschedule-date-input"
              />
              <Button
                label="Set date"
                loading={busy}
                onPress={commitTyped}
                testID="reschedule-commit"
              />
            </View>
          ) : null}

          <TimePicker
            label="Time"
            value={pickedTime}
            onChange={(value) => {
              setPickedTime(value);
              if (value === null) void commitOccurrence(initialDate, null);
            }}
            onConfirm={(value) => requestCommit(initialDate, value)}
            openAt={initialTime ?? '09:00'}
            minuteInterval={5}
            allowClear={!recurring}
            presentation="inline"
            testID="reschedule-time-picker"
          />

          {removalRow}
          {pickedTime !== null ? null : (
            <Text variant="footnote" color="textSecondary">
              Removing a time keeps reminders and moves sub-day reminders to the nearest
              whole day.
            </Text>
          )}
          {error === undefined ? null : (
            <Text accessibilityRole="alert" color="danger">
              {error}
            </Text>
          )}
        </View>
      )}
    </>
  );

  const content = clearConfirmation ? (
    <ConfirmDialog
      open
      embedded
      confirmation={{
        heading: `Remove the date from “${activity.title}”?`,
        removesLead:
          'This takes it off everyone’s day and moves it back to Needs a date.',
        removes: [],
        keeps: 'the plan, everyone on it, and their replies.',
        confirmLabel: 'Remove the date',
      }}
      busy={busy}
      onCancel={() => setClearConfirmation(false)}
      onConfirm={() => void clearDate()}
      testID="reschedule-clear-confirmation"
    />
  ) : (
    editor
  );

  if (embedded) return content;

  /**
   * `fit`, not `medium`. §6.1's detent table gives `medium` to a choice list that scrolls
   * internally, and this one does not need to: five date rows, a time control and one action
   * come to less than the 90% `fit` caps at, so a fixed 58% put `Skip this occurrence` and the
   * time below the fold on a phone for no reason. It also settles a split — the agenda
   * coordinator's outer sheet has always defaulted to `fit`, so one sheet had two heights
   * depending on which surface opened it.
   */
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="When?"
      detent="fit"
      testID="reschedule-sheet"
    >
      {content}
    </Sheet>
  );
}
