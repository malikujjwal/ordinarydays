import type { AgendaItem } from '@od/shared/types';
import { formatWallTime, Row, SectionHeader, useTheme } from '@od/ui';
import type { ReactNode } from 'react';
import { View } from 'react-native';

export interface AgendaSectionProps {
  title: string;
  items: readonly AgendaItem[];
  footer?: ReactNode;
  testID: string;
}

/** P2-19's section shell. P2-21 replaces the provisional Row body with AgendaRow. */
export function AgendaSection({ title, items, footer, testID }: AgendaSectionProps) {
  const theme = useTheme();

  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      <SectionHeader title={title} />
      {items.map((item) => (
        <Row
          key={`${item.activityId}:${item.occurrenceDate ?? ''}`}
          title={item.title}
          {...(item.time === undefined ? {} : { subtitle: formatWallTime(item.time) })}
          accent={item.type}
          dimmed={
            item.isPast ||
            item.status === 'completed' ||
            item.status === 'completed_occurrence'
          }
          struck={item.status === 'completed' || item.status === 'completed_occurrence'}
          testID={`agenda-row-${item.activityId}`}
        />
      ))}
      {footer}
    </View>
  );
}
