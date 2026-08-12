import { describeRecurrence } from '@od/shared/recurrence';
import type { Recurrence, Weekday } from '@od/shared/types';
import { Button, Chip, Field, Sheet, Text, useTheme } from '@od/ui';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { ConfirmDialog } from '@/features/activity/components/ConfirmDialog';
import { removeRecurrenceConfirmation } from '@/features/activity/model/confirmations';
import {
  buildRepeatLimitAttempt,
  buildRepeatValue,
  endRepeatSeries,
  endsForRecurrence,
  optionForSegment,
  type RepeatEnds,
  type RepeatOption,
  repeatOptions,
  weekdayChoices,
} from '@/features/activity/model/repeat';

export interface RepeatSheetProps {
  open: boolean;
  onClose: () => void;
  /** First-segment schedule date, or the all-future effective date supplied by the caller. */
  anchorDate: string;
  value?: Recurrence;
  /** Required only for the history-loss confirmation on an existing series. */
  activityForConfirmation?: {
    title: string;
  };
  completedOccurrenceCount?: number;
  onCommit: (value: Recurrence | undefined) => Promise<boolean>;
  busy?: boolean;
  error?: string;
}

function initialOption(value: Recurrence | undefined): RepeatOption {
  const active = value?.segments.at(-1);
  return active === undefined ? 'never' : optionForSegment(active);
}

function initialWeekdays(value: Recurrence | undefined): Weekday[] {
  return [...(value?.segments.at(-1)?.byWeekday ?? [])];
}

function initialInterval(value: Recurrence | undefined): number {
  return value?.segments.at(-1)?.interval ?? 2;
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  testID,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  testID: string;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[2] }} testID={testID}>
      <Text variant="footnoteStrong" color="textSecondary">
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
        <Button
          label="−"
          accessibilityLabel={`Decrease ${label}`}
          variant="secondary"
          disabled={value <= min}
          onPress={() => onChange(Math.max(min, value - 1))}
          testID={`${testID}-decrease`}
        />
        <Text
          variant="bodyStrong"
          color="textPrimary"
          accessibilityLabel={`${label}: ${value}`}
          testID={`${testID}-value`}
        >
          {String(value)}
        </Text>
        <Button
          label="+"
          accessibilityLabel={`Increase ${label}`}
          variant="secondary"
          disabled={value >= max}
          onPress={() => onChange(Math.min(max, value + 1))}
          testID={`${testID}-increase`}
        />
      </View>
    </View>
  );
}

/** The one Phase 2 editor for creation and existing-series all-future edits. */
export function RepeatSheet({
  open,
  onClose,
  anchorDate,
  value,
  activityForConfirmation,
  completedOccurrenceCount = 0,
  onCommit,
  busy = false,
  error,
}: RepeatSheetProps) {
  const theme = useTheme();
  const [option, setOption] = useState<RepeatOption>(() => initialOption(value));
  const [intervalDays, setIntervalDays] = useState(() => initialInterval(value));
  const [selectedWeekdays, setSelectedWeekdays] = useState<Weekday[]>(() =>
    initialWeekdays(value),
  );
  const [ends, setEnds] = useState<RepeatEnds>(() => endsForRecurrence(value));
  const [endDate, setEndDate] = useState(value?.endDate ?? anchorDate);
  const [endCount, setEndCount] = useState(value?.count ?? 1);
  const [confirmNever, setConfirmNever] = useState(false);
  const [seriesLimit, setSeriesLimit] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setOption(initialOption(value));
    setIntervalDays(initialInterval(value));
    setSelectedWeekdays(initialWeekdays(value));
    setEnds(endsForRecurrence(value));
    setEndDate(value?.endDate ?? anchorDate);
    setEndCount(value?.count ?? 1);
    setConfirmNever(false);
    setSeriesLimit(false);
    setLocalError(undefined);
  }, [anchorDate, open, value]);

  const effectiveEnds: RepeatEnds =
    ends.kind === 'date'
      ? { kind: 'date', date: endDate }
      : ends.kind === 'count'
        ? { kind: 'count', count: endCount }
        : { kind: 'never' };

  const candidate = useMemo(() => {
    if (
      option === 'never' ||
      (option === 'selected_weekdays' && selectedWeekdays.length === 0)
    ) {
      return undefined;
    }
    try {
      return buildRepeatValue({
        option,
        anchorDate,
        intervalDays,
        selectedWeekdays,
        ends: effectiveEnds,
        ...(value === undefined ? {} : { current: value }),
      });
    } catch {
      return buildRepeatLimitAttempt({
        option,
        anchorDate,
        intervalDays,
        selectedWeekdays,
        ends: effectiveEnds,
        ...(value === undefined ? {} : { current: value }),
      });
    }
  }, [anchorDate, effectiveEnds, intervalDays, option, selectedWeekdays, value]);

  async function commitNever() {
    if (await onCommit(undefined)) {
      setConfirmNever(false);
      onClose();
    }
  }

  async function commit() {
    setLocalError(undefined);
    setSeriesLimit(false);
    if (option === 'never') {
      if (value !== undefined && completedOccurrenceCount > 0) {
        setConfirmNever(true);
        return;
      }
      await commitNever();
      return;
    }
    if (option === 'selected_weekdays' && selectedWeekdays.length === 0) return;

    let next: Recurrence;
    try {
      next = buildRepeatValue({
        option,
        anchorDate,
        intervalDays,
        selectedWeekdays,
        ends: effectiveEnds,
        ...(value === undefined ? {} : { current: value }),
      });
    } catch {
      const limitAttempt = buildRepeatLimitAttempt({
        option,
        anchorDate,
        intervalDays,
        selectedWeekdays,
        ends: effectiveEnds,
        ...(value === undefined ? {} : { current: value }),
      });
      if (limitAttempt !== undefined) {
        if (await onCommit(limitAttempt)) {
          onClose();
          return;
        }
        setSeriesLimit(true);
        return;
      }
      setLocalError('Check the repeat settings and try again.');
      return;
    }

    if (await onCommit(next)) {
      onClose();
      return;
    }
    if (value !== undefined && value.segments.length >= 20) setSeriesLimit(true);
  }

  async function endSeries() {
    if (value === undefined) return;
    const next = endRepeatSeries(value, anchorDate);
    if (await onCommit(next)) onClose();
  }

  const summary =
    candidate === undefined ? 'Never' : describeRecurrence(candidate, anchorDate);
  const confirmation =
    activityForConfirmation === undefined
      ? undefined
      : removeRecurrenceConfirmation(activityForConfirmation, completedOccurrenceCount);

  return (
    <>
      <Sheet open={open} onClose={onClose} title="Repeat" testID="repeat-sheet">
        <ScrollView
          style={{ maxHeight: 620 }}
          contentContainerStyle={{ gap: theme.space[5] }}
        >
          <View style={{ gap: theme.space[2] }}>
            <Text variant="footnoteStrong" color="textSecondary">
              Repeats
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
              {repeatOptions.map((choice) => (
                <Chip
                  key={choice.value}
                  label={choice.label}
                  selected={option === choice.value}
                  onPress={() => {
                    setOption(choice.value);
                    if (
                      choice.value === 'selected_weekdays' &&
                      selectedWeekdays.length === 0
                    ) {
                      setSelectedWeekdays([]);
                    }
                  }}
                  testID={`repeat-option-${choice.value}`}
                />
              ))}
            </View>
          </View>

          {option === 'interval_days' ? (
            <Stepper
              label="Days"
              value={intervalDays}
              min={2}
              max={365}
              onChange={setIntervalDays}
              testID="repeat-interval"
            />
          ) : null}

          {option === 'selected_weekdays' ? (
            <View style={{ gap: theme.space[2] }}>
              <Text variant="footnoteStrong" color="textSecondary">
                Days
              </Text>
              <View
                style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}
              >
                {weekdayChoices.map((day) => (
                  <Chip
                    key={day.value}
                    label={day.label}
                    selected={selectedWeekdays.includes(day.value)}
                    onPress={() =>
                      setSelectedWeekdays((current) =>
                        current.includes(day.value)
                          ? current.filter((value) => value !== day.value)
                          : [...current, day.value],
                      )
                    }
                    testID={`repeat-weekday-${day.value}`}
                  />
                ))}
              </View>
              {selectedWeekdays.length === 0 ? (
                <Text accessibilityRole="alert" variant="footnote" color="danger">
                  Choose at least one weekday.
                </Text>
              ) : null}
            </View>
          ) : null}

          {option === 'never' ? null : (
            <View style={{ gap: theme.space[3] }}>
              <Text variant="footnoteStrong" color="textSecondary">
                Ends
              </Text>
              <View
                style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}
              >
                {(['never', 'date', 'count'] as const).map((kind) => (
                  <Chip
                    key={kind}
                    label={
                      kind === 'never'
                        ? 'Never'
                        : kind === 'date'
                          ? 'On a date'
                          : 'After N times'
                    }
                    selected={ends.kind === kind}
                    onPress={() =>
                      setEnds(
                        kind === 'date'
                          ? { kind, date: endDate }
                          : kind === 'count'
                            ? { kind, count: endCount }
                            : { kind },
                      )
                    }
                    testID={`repeat-ends-${kind}`}
                  />
                ))}
              </View>
              {ends.kind === 'date' ? (
                <Field
                  label="End date"
                  value={endDate}
                  onChangeText={setEndDate}
                  placeholder="YYYY-MM-DD"
                  testID="repeat-end-date"
                />
              ) : ends.kind === 'count' ? (
                <Stepper
                  label="Times"
                  value={endCount}
                  min={1}
                  max={999}
                  onChange={setEndCount}
                  testID="repeat-count"
                />
              ) : null}
            </View>
          )}

          <View
            style={{
              gap: theme.space[2],
              padding: theme.space[4],
              borderRadius: theme.radius.lg,
              backgroundColor: theme.colors.surfaceSunken,
            }}
            testID="repeat-summary"
          >
            <Text variant="footnote" color="textSecondary">
              Summary
            </Text>
            <Text variant="bodyStrong" color="textPrimary">
              {summary}
            </Text>
          </View>

          {seriesLimit ? (
            <View style={{ gap: theme.space[2] }} testID="repeat-series-limit">
              <Text accessibilityRole="alert" color="danger" numberOfLines={0}>
                This series already has 20 rule changes. End this series and start a new
                one to keep its history intact.
              </Text>
              <Button
                label="End series"
                variant="secondary"
                onPress={() => void endSeries()}
                testID="repeat-end-series"
              />
            </View>
          ) : localError === undefined && error === undefined ? null : (
            <Text accessibilityRole="alert" color="danger" numberOfLines={0}>
              {localError ?? error}
            </Text>
          )}

          <Button
            label="Apply repeat"
            fullWidth
            loading={busy}
            disabled={option === 'selected_weekdays' && selectedWeekdays.length === 0}
            onPress={() => void commit()}
            testID="repeat-apply"
          />
        </ScrollView>
      </Sheet>

      {confirmation === undefined ? null : (
        <ConfirmDialog
          open={confirmNever}
          confirmation={confirmation}
          busy={busy}
          onCancel={() => setConfirmNever(false)}
          onConfirm={() => void commitNever()}
          testID="repeat-never-confirmation"
        />
      )}
    </>
  );
}
