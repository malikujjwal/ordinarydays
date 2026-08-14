import type { PatchActivityInput, ScheduleActivityInput } from '@od/shared/schemas';
import type { Activity, RecurrenceSegment } from '@od/shared/types';
import { Button, Field, SettingRow, Sheet, Text, TimePicker, useTheme } from '@od/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ConfirmDialog } from '@/features/activity/components/ConfirmDialog';
import {
  formatQuickDate,
  type QuickDate,
  quickDates,
  type WallDate,
} from '@/features/activity/model/dates';

type SeriesScope = 'occurrence' | 'future';

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
 * A recurring occurrence must choose its scope before a date or time can write anything.
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
  busy = false,
  error,
}: RescheduleSheetProps) {
  const theme = useTheme();
  const recurring = activity.recurrence !== undefined;
  const active = segmentInForce(activity, occurrenceDate);
  const initialDate = renderedDate ?? occurrenceDate ?? activity.schedule?.date ?? today;
  const initialTime = renderedTime ?? active?.time ?? activity.schedule?.time ?? null;
  const [scope, setScope] = useState<SeriesScope | undefined>();
  const [picking, setPicking] = useState(false);
  const [typed, setTyped] = useState(initialDate);
  const [pickedTime, setPickedTime] = useState<string | null>(initialTime);
  const [clearConfirmation, setClearConfirmation] = useState(false);
  const [seriesLimit, setSeriesLimit] = useState(false);

  useEffect(() => {
    if (!open) return;
    setScope(recurring && occurrenceDate === undefined ? 'future' : undefined);
    setPicking(false);
    setTyped(initialDate);
    setPickedTime(initialTime);
    setClearConfirmation(false);
    setSeriesLimit(false);
  }, [initialDate, initialTime, occurrenceDate, open, recurring]);

  const effectiveScope = recurring ? scope : 'occurrence';
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
    const ok = await onPatch({
      recurrence: {
        ...recurrence,
        segments: [
          ...recurrence.segments,
          appendedSegment(active, occurrenceDate ?? today, time),
        ],
      },
      ...(occurrenceDate === undefined ? {} : { editedFromDate: occurrenceDate }),
    });
    if (ok) {
      onClose();
      return;
    }
    if (recurrence.segments.length >= 20) setSeriesLimit(true);
  };

  const choose = (chip: QuickDate) => {
    if (chip.date === undefined) {
      setPicking(true);
      return;
    }
    void commitOccurrence(chip.date, pickedTime);
  };

  const commitTyped = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(typed)) return;
    void commitOccurrence(typed, pickedTime);
  };

  const clearDate = async () => {
    if (await onSchedule({ date: null })) {
      setClearConfirmation(false);
      onClose();
    }
  };

  /**
   * **Removal language matches the object.** The frames are explicit that this is never a
   * generic "clear the date": a Task without a date is still a task and moves to Anytime, while
   * a Plan without one goes to Plans → Needs a date. `Clear the date` described the mechanic
   * and left the user to work out where the thing went.
   */
  const removal =
    activity.objectKind === 'task'
      ? { label: 'Move to Anytime', hint: 'Keeps the task, drops the date' }
      : { label: 'Remove date', hint: 'Moves this plan to “Needs a date”' };

  /**
   * §6's **action row**: the imperative label is itself the affordance, so it takes no chevron.
   * A chevron here would promise navigation this does not do.
   */
  const clearDateButton =
    activity.schedule === undefined || recurring ? null : (
      <SettingRow
        label={removal.label}
        summary={removal.hint}
        accessibilityLabel={`${removal.label}. ${removal.hint}`}
        onPress={() => {
          if (activity.participantCount > 0) {
            setClearConfirmation(true);
            return;
          }
          void clearDate();
        }}
        testID="reschedule-clear"
      />
    );

  const editor = (
    <>
      {recurring && occurrenceDate !== undefined && effectiveScope === undefined ? (
        <View style={{ gap: theme.space[3] }} testID="reschedule-scope">
          <Button
            label="This occurrence only"
            variant="secondary"
            fullWidth
            onPress={() => setScope('occurrence')}
            testID="reschedule-this-occurrence"
          />
          <Button
            label="All future occurrences"
            variant="secondary"
            fullWidth
            onPress={() => setScope('future')}
            testID="reschedule-all-future"
          />
        </View>
      ) : effectiveScope === 'future' ? (
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
          ) : error === undefined ? null : (
            <Text accessibilityRole="alert" color="danger">
              {error}
            </Text>
          )}
        </View>
      ) : (
        <View style={{ gap: theme.space[5] }} testID="reschedule-occurrence-editor">
          <View>
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
          </View>

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
            onConfirm={(value) => void commitOccurrence(initialDate, value)}
            openAt={initialTime ?? '09:00'}
            minuteInterval={5}
            allowClear={!recurring}
            presentation="inline"
            testID="reschedule-time-picker"
          />

          {clearDateButton}
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

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="When?"
      detent="medium"
      testID="reschedule-sheet"
    >
      {content}
    </Sheet>
  );
}
