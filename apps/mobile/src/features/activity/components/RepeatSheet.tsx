import { describeRecurrence } from '@od/shared/recurrence';
import type { Recurrence } from '@od/shared/types';
import { Button, DatePicker, Field, SelectField, Sheet, Text, useTheme } from '@od/ui';
import { useEffect, useMemo, useState } from 'react';
import { InputAccessoryView, Keyboard, Platform, ScrollView, View } from 'react-native';
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
} from '@/features/activity/model/repeat';

const endsOptions = [
  { value: 'never', label: 'Never' },
  { value: 'date', label: 'On a date' },
  { value: 'count', label: 'After N times' },
] as const;
const CUSTOM_DAYS_PATTERN = /^\d+$/;
const DAYS_INPUT_ACCESSORY = 'repeat-days-keyboard';
const PICK_DATE_ONLY = ['pick'] as const;

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

function initialCustomDays(value: Recurrence | undefined): number {
  if (value?.segments.at(-1)?.freq !== 'interval_days') return 2;
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
  const [customDaysText, setCustomDaysText] = useState(() =>
    String(initialCustomDays(value)),
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
    setCustomDaysText(String(initialCustomDays(value)));
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
  const parsedCustomDays = Number(customDaysText);
  const customDaysValid =
    CUSTOM_DAYS_PATTERN.test(customDaysText) &&
    Number.isInteger(parsedCustomDays) &&
    parsedCustomDays >= 2 &&
    parsedCustomDays <= 365;

  const candidate = useMemo(() => {
    if (option === 'never' || (option === 'custom' && !customDaysValid)) {
      return undefined;
    }
    try {
      return buildRepeatValue({
        option,
        anchorDate,
        customDays: parsedCustomDays,
        ends: effectiveEnds,
        ...(value === undefined ? {} : { current: value }),
      });
    } catch {
      return buildRepeatLimitAttempt({
        option,
        anchorDate,
        customDays: parsedCustomDays,
        ends: effectiveEnds,
        ...(value === undefined ? {} : { current: value }),
      });
    }
  }, [anchorDate, customDaysValid, effectiveEnds, option, parsedCustomDays, value]);

  async function commitNever() {
    if (await onCommit(undefined)) {
      setConfirmNever(false);
      close();
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
    if (option === 'custom' && !customDaysValid) return;

    let next: Recurrence;
    try {
      next = buildRepeatValue({
        option,
        anchorDate,
        customDays: parsedCustomDays,
        ends: effectiveEnds,
        ...(value === undefined ? {} : { current: value }),
      });
    } catch {
      const limitAttempt = buildRepeatLimitAttempt({
        option,
        anchorDate,
        customDays: parsedCustomDays,
        ends: effectiveEnds,
        ...(value === undefined ? {} : { current: value }),
      });
      if (limitAttempt !== undefined) {
        if (await onCommit(limitAttempt)) {
          close();
          return;
        }
        setSeriesLimit(true);
        return;
      }
      setLocalError('Check the repeat settings and try again.');
      return;
    }

    if (await onCommit(next)) {
      close();
      return;
    }
    if (value !== undefined && value.segments.length >= 20) setSeriesLimit(true);
  }

  async function endSeries() {
    if (value === undefined) return;
    const next = endRepeatSeries(value, anchorDate);
    if (await onCommit(next)) close();
  }

  const summary =
    option === 'custom' && !customDaysValid
      ? 'Enter a number from 2 to 365 days.'
      : candidate === undefined
        ? 'Never'
        : describeRecurrence(candidate, anchorDate);
  const confirmation =
    activityForConfirmation === undefined
      ? undefined
      : removeRecurrenceConfirmation(activityForConfirmation, completedOccurrenceCount);

  function close() {
    Keyboard.dismiss();
    onClose();
  }

  return (
    <>
      <Sheet open={open} onClose={close} title="Repeat" testID="repeat-sheet">
        <ScrollView
          style={{ maxHeight: 620 }}
          contentContainerStyle={{ gap: theme.space[5] }}
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps="handled"
        >
          <SelectField
            label="Repeats"
            value={option}
            options={repeatOptions}
            onChange={setOption}
            testID="repeat-option"
          />

          {option === 'custom' ? (
            <Field
              label="Days"
              value={customDaysText}
              onChangeText={setCustomDaysText}
              keyboardType="number-pad"
              inputAccessoryViewID={DAYS_INPUT_ACCESSORY}
              maxLength={3}
              {...(customDaysValid ? {} : { error: 'Enter a number from 2 to 365.' })}
              testID="repeat-interval"
            />
          ) : null}

          {option === 'never' ? null : (
            <View style={{ gap: theme.space[3] }}>
              <SelectField
                label="Ends"
                value={ends.kind}
                options={endsOptions}
                onChange={(kind) =>
                  setEnds(
                    kind === 'date'
                      ? { kind, date: endDate }
                      : kind === 'count'
                        ? { kind, count: endCount }
                        : { kind },
                  )
                }
                testID="repeat-ends"
              />
              {ends.kind === 'date' ? (
                <DatePicker
                  label="End date"
                  value={endDate}
                  onChange={(date) => {
                    if (date !== null) setEndDate(date);
                  }}
                  today={anchorDate}
                  min={anchorDate}
                  quickOptions={PICK_DATE_ONLY}
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
            disabled={option === 'custom' && !customDaysValid}
            onPress={() => void commit()}
            testID="repeat-apply"
          />
        </ScrollView>
      </Sheet>

      {Platform.OS === 'ios' && option === 'custom' ? (
        <InputAccessoryView nativeID={DAYS_INPUT_ACCESSORY}>
          <View
            style={{
              alignItems: 'flex-end',
              paddingHorizontal: theme.space[4],
              paddingVertical: theme.space[2],
              backgroundColor: theme.colors.surfaceOverlay,
            }}
          >
            <Button label="Done" variant="ghost" onPress={Keyboard.dismiss} />
          </View>
        </InputAccessoryView>
      ) : null}

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
