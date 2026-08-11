import type { AgendaItem } from '@od/shared/types';
import { Card, formatWallTime, SectionHeader, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import type { UpNextSelection } from '@/features/agenda/model/upNext';
import { AgendaRow } from './AgendaRow';

export interface UpNextCardProps {
  selection: UpNextSelection;
  onOpen: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
}

/** Today's one hero surface; its body remains the canonical AgendaRow. */
export function UpNextCard({ selection, onOpen, onToggleComplete }: UpNextCardProps) {
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
          <Text variant="heading">{formatWallTime(selection.time)}</Text>
          <Text variant="footnoteStrong" color="accent">
            {selection.relativeTime}
          </Text>
        </View>
        <AgendaRow
          item={selection.item}
          onOpen={onOpen}
          {...(onToggleComplete === undefined ? {} : { onToggleComplete })}
        />
      </Card>
    </View>
  );
}
