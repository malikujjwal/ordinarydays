import type { ActivityType, AgendaItem } from '@od/shared/types';
import { Chip, formatWallTime, Text, Touchable, useTheme } from '@od/ui';
import type { AccessibilityActionEvent } from 'react-native';
import { View } from 'react-native';
import {
  canResolvePassedAgendaItem,
  passedPlanResolution,
} from '@/lib/passedPlanResolution';
import { RowBadges } from './RowBadges';
import { RowLeading } from './RowLeading';

export interface AgendaRowProps {
  item: AgendaItem;
  today?: string;
  /** Date context spoken for untimed rows outside Today. */
  untimedContextLabel?: string;
  showTime?: boolean;
  /** Cards turn off the ordinary list divider while retaining this same row body. */
  divider?: boolean;
  onOpen: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
  onOpenReschedule?: (item: AgendaItem) => void;
  onOpenOverdue?: (item: AgendaItem) => void;
  onOpenResolution?: (item: AgendaItem) => void;
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  onBodyFocus?: () => void;
  onBodyBlur?: () => void;
}

const COMPLETED_STATUSES = new Set<AgendaItem['status']>([
  'completed',
  'completed_occurrence',
]);

const SKIPPED_STATUSES = new Set<AgendaItem['status']>(['skipped', 'skipped_occurrence']);

function completionVerb(type: ActivityType): string {
  switch (type) {
    case 'task':
      return 'Complete';
    case 'meal':
      return 'Had it';
    case 'watch':
      return 'Watched';
    case 'event':
      return 'Attended';
    case 'custom':
      return 'Done';
  }
}

function bodyLabel(
  item: AgendaItem,
  checked: boolean,
  untimedContextLabel: string,
): string {
  const parts = [item.title];
  if (checked) parts.push(completionVerb(item.type));
  if (item.subtitle !== undefined) parts.push(item.subtitle);
  if (item.time === undefined) parts.push(untimedContextLabel, 'no time');
  else parts.push(formatWallTime(item.time));
  if (item.recurrenceDescription !== undefined) parts.push(item.recurrenceDescription);
  if (item.locationLabel !== undefined) parts.push(item.locationLabel);
  if (item.participantAvatars.length > 0) {
    parts.push(
      `with ${item.participantAvatars.map(({ displayName }) => displayName).join(', ')}`,
    );
  }
  return parts.join(', ');
}

/** The shared agenda row body; gestures and optimistic state are added by their owning tasks. */
export function AgendaRow({
  item,
  today,
  untimedContextLabel = 'today',
  showTime = false,
  divider = true,
  onOpen,
  onToggleComplete,
  onOpenReschedule,
  onOpenOverdue,
  onOpenResolution,
  accessibilityActions,
  onAccessibilityAction,
  onBodyFocus,
  onBodyBlur,
}: AgendaRowProps) {
  const theme = useTheme();
  const checked = COMPLETED_STATUSES.has(item.status);
  const dimmed = item.isPast || checked || SKIPPED_STATUSES.has(item.status);
  const formattedTime = item.time === undefined ? undefined : formatWallTime(item.time);

  return (
    <View
      testID={`agenda-row-${item.activityId}`}
      style={{
        minHeight: theme.layout.rowMinHeight,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space[3],
        paddingVertical: theme.space[5],
        borderBottomWidth: divider ? 1 : 0,
        borderBottomColor: theme.colors.border,
        opacity: dimmed ? 0.62 : 1,
      }}
    >
      <View
        style={{
          marginLeft:
            showTime && formattedTime !== undefined
              ? theme.space[10] + theme.space[3]
              : theme.space[0],
        }}
      >
        <RowLeading
          hasCheckbox={item.hasCheckbox}
          checked={checked}
          title={item.title}
          {...(onToggleComplete === undefined
            ? {}
            : { onChange: (next) => onToggleComplete(item, next) })}
        />
      </View>

      <View style={{ flex: 1, minWidth: 0, gap: theme.space[2] }}>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={bodyLabel(item, checked, untimedContextLabel)}
          {...(accessibilityActions === undefined ? {} : { accessibilityActions })}
          {...(onAccessibilityAction === undefined ? {} : { onAccessibilityAction })}
          {...(onBodyFocus === undefined ? {} : { onFocus: onBodyFocus })}
          {...(onBodyBlur === undefined ? {} : { onBlur: onBodyBlur })}
          onPress={() => onOpen(item)}
          testID="agenda-row-body"
          style={{ alignItems: 'flex-start' }}
        >
          <Text struck={checked}>{item.title}</Text>
          {item.subtitle === undefined ? null : (
            <Text variant="subhead" color="textSecondary">
              {item.subtitle}
            </Text>
          )}
        </Touchable>

        <RowBadges
          {...(!item.isRecurring || item.recurrenceDescription === undefined
            ? {}
            : { recurrenceDescription: item.recurrenceDescription })}
          {...(!item.isSnoozed || item.originalTime === undefined
            ? {}
            : { originalTime: item.originalTime })}
          {...(item.time === undefined ? {} : { effectiveTime: item.time })}
          {...(item.overdueFromDate === undefined
            ? {}
            : { overdueFromDate: item.overdueFromDate })}
          {...(today === undefined ? {} : { today })}
          participantAvatars={item.participantAvatars}
          {...(onOpenOverdue === undefined
            ? {}
            : { onOpenOverdue: () => onOpenOverdue(item) })}
        />
      </View>

      {!showTime || formattedTime === undefined ? null : (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={`${formattedTime}, change time`}
          onPress={() => onOpenReschedule?.(item)}
          testID="agenda-row-time"
          style={{
            position: 'absolute',
            top: theme.space[5],
            left: theme.space[0],
            width: theme.space[10],
            alignItems: 'flex-start',
          }}
        >
          <Text variant="footnote" color="textSecondary">
            {formattedTime}
          </Text>
        </Touchable>
      )}

      {checked && !item.hasCheckbox ? (
        <View
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text variant="footnoteStrong" color="textSecondary">
            {completionVerb(item.type)}
          </Text>
        </View>
      ) : null}

      {!canResolvePassedAgendaItem(item) || onOpenResolution === undefined ? null : (
        <Chip
          label={passedPlanResolution(item.type).prompt}
          accessibilityLabel={`${passedPlanResolution(item.type).prompt} Choose an outcome for ${item.title}`}
          tone="neutral"
          onPress={() => onOpenResolution(item)}
          testID="agenda-resolution-prompt"
        />
      )}
    </View>
  );
}
