import type { WallDate } from '@od/shared/time';
import {
  Calendar,
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
import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Switch to the fixed two-row month chrome while preserving remembered calendar state. */
  compact?: boolean;
  /** Keep the dated list's first row clear of this non-layout overlay. */
  onHeightChange?: (height: number) => void;
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
  compact = false,
  onHeightChange,
}: CalendarNavigatorProps) {
  const theme = useTheme();
  const motion = useMotion();
  const presentation = useRef(new Animated.Value(compact ? 1 : 0)).current;
  const compactGridProgress = useRef(new Animated.Value(0)).current;
  const [contentHeight, setContentHeight] = useState(0);
  const [calendarBodyHeight, setCalendarBodyHeight] = useState(0);
  const [compactOpen, setCompactOpen] = useState(false);
  const navigator = useCalendarNavigator({
    stage,
    today,
    projection,
    loadRange,
    ...(settleMs === undefined ? {} : { settleMs }),
    ...(storage === undefined ? {} : { storage }),
    ...(compact ? { expandedOverride: compactOpen, windowExpandedOverride: true } : {}),
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(() => Number(navigator.month.slice(0, 4)));

  useEffect(() => {
    const transition = Animated.timing(presentation, {
      toValue: compact ? 1 : 0,
      duration: motion.duration.base,
      useNativeDriver: true,
    });
    transition.start();
    return () => transition.stop();
  }, [compact, motion.duration.base, presentation]);

  useEffect(() => {
    if (!compact) setCompactOpen(false);
  }, [compact]);

  useEffect(() => {
    if (compact) {
      onHeightChange?.(
        compactOpen
          ? theme.layout.hitTarget + calendarBodyHeight
          : theme.layout.hitTarget,
      );
    }
    const transition = Animated.timing(compactGridProgress, {
      toValue: compactOpen ? 1 : 0,
      duration: motion.duration.base,
      useNativeDriver: true,
    });
    transition.start();
    return () => transition.stop();
  }, [
    compact,
    compactGridProgress,
    compactOpen,
    calendarBodyHeight,
    motion.duration.base,
    onHeightChange,
    theme.layout.hitTarget,
  ]);

  const select = useCallback(
    (date: WallDate) => {
      if (navigator.expanded) navigator.setMonth(monthOf(date));
      onSelectDate(date);
    },
    [navigator.expanded, navigator.setMonth, onSelectDate],
  );

  const weeks = chunkWeeks(navigator.cells);
  const gridExpanded = compact || navigator.expanded;
  const toggle = (
    <IconButton
      icon={navigator.expanded ? ChevronUp : ChevronDown}
      label={navigator.expanded ? 'Collapse calendar' : 'Expand calendar'}
      tone="accent"
      disabled={compact}
      onPress={() => navigator.setExpanded(!navigator.expanded)}
      testID={`${testID}-toggle`}
    />
  );

  const openPicker = () => {
    setPickerYear(Number(navigator.month.slice(0, 4)));
    setPickerOpen(true);
  };

  const fullControls = navigator.expanded ? (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <IconButton
        icon={ChevronLeft}
        label="Previous month"
        tone="accent"
        disabled={compact || !navigator.canGoBack}
        onPress={() => navigator.shift(-1)}
        testID={`${testID}-previous`}
      />
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${monthTitle(navigator.month)}. Choose a month`}
        disabled={compact}
        onPress={openPicker}
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
          disabled={compact || !navigator.canGoForward}
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
      }}
    >
      <Text variant="caption" color="textSecondary" testID={`${testID}-caption`}>
        {STRIP_CAPTION[stage]}
      </Text>
      {toggle}
    </View>
  );

  const compactControls = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: theme.layout.hitTarget,
      }}
    >
      <IconButton
        icon={ChevronLeft}
        label="Previous month"
        tone="accent"
        disabled={!compact || !navigator.canGoBack}
        onPress={() => navigator.shift(-1)}
        testID={`${testID}-compact-previous`}
      />
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${monthTitle(navigator.month)}. Choose a month`}
        disabled={!compact}
        onPress={openPicker}
        square={false}
        testID={`${testID}-compact-month`}
        style={{ flex: 1, alignItems: 'center' }}
      >
        <Text variant="subhead" color="textPrimary" numberOfLines={1}>
          {monthTitle(navigator.month)}
        </Text>
      </Touchable>
      <IconButton
        icon={ChevronRight}
        label="Next month"
        tone="accent"
        disabled={!compact || !navigator.canGoForward}
        onPress={() => navigator.shift(1)}
        testID={`${testID}-compact-next`}
      />
      <IconButton
        icon={Calendar}
        label={compactOpen ? 'Close full calendar' : 'Open full calendar'}
        tone="accent"
        disabled={!compact}
        onPress={() => setCompactOpen((open) => !open)}
        testID={`${testID}-compact-toggle`}
      />
    </View>
  );

  const calendarBody = (
    <>
      {gridExpanded ? (
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
                compact={gridExpanded}
                loading={navigator.loading}
                disabled={compact && !compactOpen}
                {...(gridExpanded
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
            disabled={compact && !compactOpen}
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
    </>
  );

  return (
    <Animated.View
      testID={testID}
      accessibilityState={{ expanded: navigator.expanded }}
      style={{
        position: 'relative',
        overflow: compact ? 'visible' : 'hidden',
        // The navigator floats above the dated list; without its own paper surface, rows
        // show through while the calendar translates and make the header look clipped.
        backgroundColor: theme.colors.surface,
      }}
    >
      <View
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          if (height > 0 && height !== contentHeight) {
            setContentHeight(height);
            onHeightChange?.(height);
          }
        }}
        style={{ paddingBottom: compact ? theme.space[0] : theme.space[4] }}
      >
        <View
          style={{
            height: theme.layout.hitTarget,
            paddingBottom: compact ? theme.space[0] : theme.space[2],
          }}
        >
          <Animated.View
            aria-hidden={compact}
            accessibilityElementsHidden={compact}
            importantForAccessibility={compact ? 'no-hide-descendants' : 'auto'}
            pointerEvents={compact ? 'none' : 'auto'}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              opacity: presentation.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 0],
              }),
              transform: [
                {
                  translateY: presentation.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, -theme.space[3]],
                  }),
                },
              ],
            }}
          >
            {fullControls}
          </Animated.View>
          <Animated.View
            aria-hidden={!compact}
            accessibilityElementsHidden={!compact}
            importantForAccessibility={!compact ? 'no-hide-descendants' : 'auto'}
            pointerEvents={compact ? 'auto' : 'none'}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              opacity: presentation,
              transform: [
                {
                  translateY: presentation.interpolate({
                    inputRange: [0, 1],
                    outputRange: [theme.space[3], 0],
                  }),
                },
              ],
            }}
          >
            {compactControls}
          </Animated.View>
        </View>
        <Animated.View
          testID={`${testID}-compact-grid`}
          aria-hidden={compact && !compactOpen}
          accessibilityElementsHidden={compact && !compactOpen}
          importantForAccessibility={
            compact && !compactOpen ? 'no-hide-descendants' : 'auto'
          }
          pointerEvents={compact && !compactOpen ? 'none' : 'auto'}
          onLayout={(event) => {
            const bodyHeight = event.nativeEvent.layout.height;
            if (bodyHeight > 0 && bodyHeight !== calendarBodyHeight) {
              setCalendarBodyHeight(bodyHeight);
            }
          }}
          style={{
            ...(compact
              ? {
                  position: 'absolute' as const,
                  top: theme.layout.hitTarget,
                  left: 0,
                  right: 0,
                  paddingBottom: theme.space[4],
                  backgroundColor: theme.colors.surface,
                  opacity: compactGridProgress,
                  transform: [
                    {
                      translateY: compactGridProgress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-theme.space[3], 0],
                      }),
                    },
                  ],
                }
              : { opacity: 1 }),
          }}
        >
          {calendarBody}
        </Animated.View>

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
