import type { AgendaItem } from '@od/shared/types';
import { Card, formatWallTime, SectionHeader, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';
import type { AgendaSwipeAction } from '@/features/agenda/model/swipeActions';
import type { UpNextSelection } from '@/features/agenda/model/upNext';
import { SwipeableRow } from './SwipeableRow';

export interface UpNextCardProps {
  selection: UpNextSelection;
  onOpen: (item: AgendaItem) => void;
  onOpenReschedule?: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
  onAction?: (item: AgendaItem, action: AgendaSwipeAction) => void;
}

/** Today's one hero surface; its body remains the canonical AgendaRow. */
export function UpNextCard({
  selection,
  onOpen,
  onOpenReschedule,
  onToggleComplete,
  onAction,
}: UpNextCardProps) {
  const theme = useTheme();

  return (
    <View testID="today-up-next" style={{ gap: theme.space[2] }}>
      <SectionHeader title="Up next" />
      <Card hero radius="xl" elevation="e3" testID="up-next-card">
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: theme.space[3],
          }}
        >
          {onOpenReschedule === undefined ? (
            <Text variant="heading">{formatWallTime(selection.time)}</Text>
          ) : (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={`${formatWallTime(selection.time)}, change time`}
              onPress={() => onOpenReschedule(selection.item)}
              testID="up-next-time"
            >
              <Text variant="heading">{formatWallTime(selection.time)}</Text>
            </Touchable>
          )}
          <Text variant="footnoteStrong" color="accent">
            {selection.relativeTime}
          </Text>
        </View>
        <SwipeableRow
          item={selection.item}
          onOpen={onOpen}
          {...(onToggleComplete === undefined ? {} : { onToggleComplete })}
          {...(onAction === undefined ? {} : { onAction })}
        />
      </Card>
    </View>
  );
}
