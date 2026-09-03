import type { WallDate } from '@od/shared/time';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  IconButton,
  Sheet,
  Skeleton,
  Text,
  Touchable,
  useMotion,
  useTheme,
} from '@od/ui';
import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import {
  type CalendarLoadRange,
  type CalendarStorage,
  useCalendarNavigator,
} from '../hooks/useCalendarNavigator';
import {
  type CalendarMonth,
  type CalendarProjection,
  type CalendarStage,
  canShowMonth,
  chunkWeeks,
  monthOf,
  monthShortName,
  monthTitle,
  WEEKDAY_LABELS,
  weekdayIndex,
} from '../model/deriveCalendarCells';
import { DayCell } from './DayCell';

/**
 * The Upcoming/Past calendar navigator (P3-48, `plans-and-lists.md` §1.3.4).
 *
 * Collapsed: a rolling seven-day strip under `Next 7 days` or `Previous 7 days`. Expanded: a
 * normal month calendar with the same geometry in both stages. Needs a date never mounts
 * it. The header tap opens a month/year grid clamped to the stage's direction, and the clamp
 * is visible everywhere — a dimmed arrow, a dimmed month — so nothing silently does nothing.
 *
 * A day tap jumps **within the active stage**: it moves the displayed month and asks the
 * screen to land the list on that date. It never switches the stage and never writes.
 */
export interface CalendarNavigatorProps {
  stage: CalendarStage;
  today: WallDate;
  /** The projected store the list renders — never a response envelope. */
  projection: CalendarProjection;
  loadRange: CalendarLoadRange;
  onSelectDate: (date: WallDate) => void;
  settleMs?: number;
  storage?: CalendarStorage;
  testID?: string;
  /** Preserve navigator state while the list temporarily reclaims its vertical space. */
  hidden?: boolean;
}

/** Stable keys for the Monday-first header; two labels read `T` and two read `S`. */
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const STRIP_CAPTION: Record<CalendarStage, string> = {
  upcoming: 'Next 7 days',
  past: 'Previous 7 days',
};

export function CalendarNavigator({
  stage,
  today,
  projection,
  loadRange,
  onSelectDate,
  settleMs,
  storage,
  testID = 'plans-calendar',
  hidden = false,
}: CalendarNavigatorProps) {
  const theme = useTheme();
  const motion = useMotion();
  const visibility = useRef(new Animated.Value(hidden ? 0 : 1)).current;
  const [contentHeight, setContentHeight] = useState(0);
  const navigator = useCalendarNavigator({
    stage,
    today,
    projection,
    loadRange,
    ...(settleMs === undefined ? {} : { settleMs }),
    ...(storage === undefined ? {} : { storage }),
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(() => Number(navigator.month.slice(0, 4)));

  useEffect(() => {
    const transition = Animated.timing(visibility, {
      toValue: hidden ? 0 : 1,
      duration: motion.duration.base,
      useNativeDriver: false,
    });
    transition.start();
    return () => transition.stop();
  }, [hidden, motion.duration.base, visibility]);

  const select = (date: WallDate) => {
    if (navigator.expanded) navigator.setMonth(monthOf(date));
    onSelectDate(date);
  };

  const weeks = chunkWeeks(navigator.cells);
  const toggle = (
    <IconButton
      icon={navigator.expanded ? ChevronUp : ChevronDown}
      label={navigator.expanded ? 'Collapse calendar' : 'Expand calendar'}
      tone="accent"
      onPress={() => navigator.setExpanded(!navigator.expanded)}
      testID={`${testID}-toggle`}
    />
  );

  return (
    <Animated.View
      testID={testID}
      accessibilityState={{ expanded: navigator.expanded }}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={{
        overflow: 'hidden',
        opacity: visibility,
        maxHeight:
          contentHeight === 0
            ? undefined
            : visibility.interpolate({
                inputRange: [0, 1],
                outputRange: [0, contentHeight],
              }),
        transform: [
          {
            translateY: visibility.interpolate({
              inputRange: [0, 1],
              outputRange: [-theme.space[2], 0],
            }),
          },
        ],
        pointerEvents: hidden ? 'none' : 'auto',
      }}
    >
      <View
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          if (height > 0 && height !== contentHeight) setContentHeight(height);
        }}
        style={{ paddingBottom: theme.space[4] }}
      >
        {navigator.expanded ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingBottom: theme.space[2],
            }}
          >
            <IconButton
              icon={ChevronLeft}
              label="Previous month"
              tone="accent"
              disabled={!navigator.canGoBack}
              onPress={() => navigator.shift(-1)}
              testID={`${testID}-previous`}
            />
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={`${monthTitle(navigator.month)}. Choose a month`}
              onPress={() => {
                setPickerYear(Number(navigator.month.slice(0, 4)));
                setPickerOpen(true);
              }}
              square={false}
              testID={`${testID}-month`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}
            >
              <Text variant="subhead" color="textPrimary">
                {monthTitle(navigator.month)}
              </Text>
              <Text variant="caption" color="textAction">
                ▾
              </Text>
            </Touchable>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <IconButton
                icon={ChevronRight}
                label="Next month"
                tone="accent"
                disabled={!navigator.canGoForward}
                onPress={() => navigator.shift(1)}
                testID={`${testID}-next`}
              />
              {toggle}
            </View>
          </View>
        ) : (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingBottom: theme.space[2],
            }}
          >
            <Text variant="caption" color="textSecondary" testID={`${testID}-caption`}>
              {STRIP_CAPTION[stage]}
            </Text>
            {toggle}
          </View>
        )}

        {navigator.expanded ? (
          <View style={{ flexDirection: 'row', gap: 3, marginBottom: theme.space[1] }}>
            {WEEKDAY_LABELS.map((label, index) => (
              <View key={WEEKDAY_KEYS[index]} style={{ flex: 1, alignItems: 'center' }}>
                <Text variant="caption" color="textMuted">
                  {label}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={{ gap: 4 }} testID={`${testID}-grid`}>
          {weeks.map((week) => (
            <View key={week[0]?.date ?? 'week'} style={{ flexDirection: 'row', gap: 3 }}>
              {week.map((cell) => (
                <DayCell
                  key={cell.date}
                  cell={cell}
                  stage={stage}
                  compact={navigator.expanded}
                  loading={navigator.loading}
                  {...(navigator.expanded
                    ? {}
                    : { weekday: WEEKDAY_LABELS[weekdayIndex(cell.date)] ?? '' })}
                  onPress={select}
                />
              ))}
            </View>
          ))}
        </View>

        {navigator.loading ? (
          <View testID={`${testID}-loading`} style={{ paddingTop: theme.space[2] }}>
            <Skeleton shape="text" count={1} />
          </View>
        ) : navigator.failed ? (
          <View
            testID={`${testID}-error`}
            accessibilityRole="alert"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: theme.space[2],
            }}
          >
            <Text variant="footnote" color="textSecondary">
              Couldn't load this month.
            </Text>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Try again"
              onPress={navigator.retry}
              square={false}
              testID={`${testID}-retry`}
            >
              <Text variant="footnoteStrong" color="textAction">
                Try again
              </Text>
            </Touchable>
          </View>
        ) : null}

        <MonthYearSheet
          open={pickerOpen}
          stage={stage}
          today={today}
          year={pickerYear}
          month={navigator.month}
          onYear={setPickerYear}
          onChoose={(month) => {
            navigator.setMonth(month);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
          testID={`${testID}-picker`}
        />
      </View>
    </Animated.View>
  );
}

interface MonthYearSheetProps {
  open: boolean;
  stage: CalendarStage;
  today: WallDate;
  year: number;
  month: CalendarMonth;
  onYear: (year: number) => void;
  onChoose: (month: CalendarMonth) => void;
  onClose: () => void;
  testID: string;
}

/** The header tap's month/year grid, clamped to the stage's direction (§1.3.4). */
function MonthYearSheet({
  open,
  stage,
  today,
  year,
  month,
  onYear,
  onChoose,
  onClose,
  testID,
}: MonthYearSheetProps) {
  const theme = useTheme();
  const months = Array.from(
    { length: 12 },
    (_, index) =>
      `${String(year).padStart(4, '0')}-${String(index + 1).padStart(2, '0')}`,
  );
  const canGoBack = canShowMonth(stage, `${String(year - 1).padStart(4, '0')}-12`, today);
  const canGoForward = canShowMonth(
    stage,
    `${String(year + 1).padStart(4, '0')}-01`,
    today,
  );
  const note =
    stage === 'upcoming'
      ? 'Months entirely before today are unreachable from Upcoming. The stage decides what this offers, not the month on screen.'
      : 'Months after this one are unreachable from Past. The stage decides what this offers, not the month on screen.';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Choose a month"
      detent="medium"
      testID={testID}
    >
      <View style={{ gap: theme.space[4] }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <IconButton
            icon={ChevronLeft}
            label="Previous year"
            tone="accent"
            disabled={!canGoBack}
            onPress={() => onYear(year - 1)}
            testID={`${testID}-previous-year`}
          />
          <Text variant="subhead" color="textPrimary" testID={`${testID}-year`}>
            {String(year)}
          </Text>
          <IconButton
            icon={ChevronRight}
            label="Next year"
            tone="accent"
            disabled={!canGoForward}
            onPress={() => onYear(year + 1)}
            testID={`${testID}-next-year`}
          />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
          {months.map((candidate) => {
            const allowed = canShowMonth(stage, candidate, today);
            const selected = candidate === month;
            return (
              <Touchable
                key={candidate}
                accessibilityRole="button"
                accessibilityLabel={monthTitle(candidate)}
                accessibilityState={{ disabled: !allowed, selected }}
                disabled={!allowed}
                onPress={() => onChoose(candidate)}
                square={false}
                testID={`${testID}-${candidate}`}
                style={{
                  width: '31%',
                  paddingVertical: theme.space[3],
                  alignItems: 'center',
                  borderRadius: theme.radius.md,
                  backgroundColor: selected
                    ? theme.colors.accentSurface
                    : allowed
                      ? theme.colors.surfaceSunken
                      : 'transparent',
                  borderWidth: 1,
                  borderColor: selected ? theme.colors.accentBorder : 'transparent',
                }}
              >
                <Text
                  variant={selected ? 'bodyStrong' : 'body'}
                  color={
                    selected ? 'textAction' : allowed ? 'textPrimary' : 'textDisabled'
                  }
                >
                  {monthShortName(candidate)}
                </Text>
              </Touchable>
            );
          })}
        </View>
        <Text variant="footnote" color="textMuted">
          {note}
        </Text>
      </View>
    </Sheet>
  );
}
