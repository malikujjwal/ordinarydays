import { Text, Touchable, useTheme } from '@od/ui';
import { memo } from 'react';
import { View } from 'react-native';
import {
  type CalendarCell,
  type CalendarStage,
  cellDateLabel,
  planLoadHeight,
} from '../model/deriveCalendarCells';

/**
 * One day of the navigator (P3-48). The same cell is drawn seven times on the strip and up to
 * forty-two times on the month grid; only `compact` and the weekday letter differ.
 *
 * Three visual states for three meanings (§1.3.4): `live` is the normal treatment; `spill` —
 * a live date from a neighbouring month — is subordinate but plainly readable and tappable,
 * and it **must not read as disabled**; `inert` is out of stage and not a target.
 *
 * Encoding: Upcoming draws a load bar for plans and a dot for tasks; a covered empty date
 * draws the empty hairline. Past draws a presence dot only — **no dot means no claim** — and
 * never a bar, because a bar implies a measured quantity. An uncovered date draws nothing.
 */
export interface DayCellProps {
  cell: CalendarCell;
  stage: CalendarStage;
  /** The strip shows the weekday letter above the numeral; the grid has a header row. */
  weekday?: string;
  compact?: boolean;
  /** While the visible range loads, uncovered Upcoming cells show a quiet placeholder. */
  loading?: boolean;
  onPress?: (date: CalendarCell['date']) => void;
}

const BAR_SLOT = 18;
const BAR_SLOT_COMPACT = 14;

function densityLabel(cell: CalendarCell, stage: CalendarStage): string {
  if (stage === 'past') return cell.known ? ', activity' : '';
  if (!cell.covered) return '';
  const parts: string[] = [];
  if (cell.plans > 0) parts.push(`${cell.plans} ${cell.plans === 1 ? 'plan' : 'plans'}`);
  if (cell.hasTasks) parts.push('tasks');
  return parts.length === 0 ? ', nothing planned' : `, ${parts.join(', ')}`;
}

export const DayCell = memo(function DayCell({
  cell,
  stage,
  weekday,
  compact = false,
  loading = false,
  onPress,
}: DayCellProps) {
  const theme = useTheme();
  const inert = cell.state === 'inert';
  const barSlot = compact ? BAR_SLOT_COMPACT : BAR_SLOT;
  const barHeight = planLoadHeight(cell.plans);
  /** Weekday + numeral + two density slots + gaps/padding at the default type scale. */
  const stripCellMinHeight = theme.layout.hitTarget + theme.space[7] + theme.space[2];

  const marks =
    stage === 'upcoming' ? (
      <>
        <View
          style={{ height: barSlot, justifyContent: 'flex-end', alignItems: 'center' }}
        >
          {inert || (!cell.covered && !loading) ? null : !cell.covered ? (
            <View
              testID={`calendar-placeholder-${cell.date}`}
              style={{
                width: 10,
                height: 2,
                borderRadius: 999,
                backgroundColor: theme.colors.surfaceSunken,
              }}
            />
          ) : barHeight === 0 ? (
            <View
              testID={`calendar-empty-${cell.date}`}
              style={{
                width: 10,
                height: 2,
                borderRadius: 999,
                backgroundColor: theme.colors.border,
              }}
            />
          ) : (
            <View
              testID={`calendar-bar-${cell.date}`}
              style={{
                width: 8,
                height: barHeight,
                borderRadius: 2,
                backgroundColor: theme.colors.accent,
              }}
            />
          )}
        </View>
        <View style={{ height: 7, justifyContent: 'center', alignItems: 'center' }}>
          {!inert && cell.covered && cell.hasTasks ? (
            <View
              testID={`calendar-dot-${cell.date}`}
              style={{
                width: 3.5,
                height: 3.5,
                borderRadius: 999,
                backgroundColor: theme.colors.textMuted,
              }}
            />
          ) : null}
        </View>
      </>
    ) : (
      <>
        <View style={{ height: barSlot }} />
        <View style={{ height: 7, justifyContent: 'center', alignItems: 'center' }}>
          {!inert && cell.known ? (
            <View
              testID={`calendar-dot-${cell.date}`}
              style={{
                width: 4.5,
                height: 4.5,
                borderRadius: 999,
                backgroundColor: theme.colors.accent,
              }}
            />
          ) : null}
        </View>
      </>
    );

  const body = (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        gap: 2,
        paddingVertical: compact ? 3 : 4,
        borderRadius: theme.radius.sm,
        // Subordinate-but-live is opacity 0.62; inert is 0.32 — the mock's two steps.
        opacity: cell.state === 'spill' ? 0.62 : inert ? 0.32 : 1,
        ...(cell.isToday
          ? { borderWidth: 1.5, borderColor: theme.colors.accentBorder }
          : { borderWidth: 1.5, borderColor: 'transparent' }),
      }}
    >
      {weekday === undefined ? null : (
        <Text variant="caption" color="textMuted">
          {weekday}
        </Text>
      )}
      <Text
        variant={cell.isToday ? 'footnoteStrong' : 'footnote'}
        color={cell.isToday ? 'textAction' : 'textSecondary'}
      >
        {String(cell.day)}
      </Text>
      {marks}
    </View>
  );

  const label = `${cellDateLabel(cell.date)}${densityLabel(cell, stage)}`;

  if (inert || onPress === undefined) {
    return (
      <View
        style={{
          flex: 1,
          minWidth: 0,
          ...(compact ? {} : { minHeight: stripCellMinHeight }),
        }}
        testID={`calendar-cell-${cell.date}`}
        accessibilityLabel={label}
        accessibilityState={{ disabled: true }}
      >
        {body}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onPress(cell.date)}
      testID={`calendar-cell-${cell.date}`}
      dataSet={{ state: cell.state }}
      style={{
        flex: 1,
        minWidth: 0,
        ...(compact ? {} : { minHeight: stripCellMinHeight }),
      }}
    >
      {body}
    </Touchable>
  );
});
