import type { SourceListSummary } from '@od/shared/types';
import { Text, Touchable, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionRow } from '@/features/activity/components/ActionRow';
import { SectionFrame } from '@/features/activity/components/SectionFrame';
import { peekRows, sourceListLine } from '@/features/activity/model/planSections';

/** The LISTS section (P3-37/P3-39): the Plan's own Lists, each row opening its detail. */
export interface ListsSectionProps {
  sourceLists: readonly SourceListSummary[];
  onOpenList: (listId: string) => void;
  /** P3-39's `+ Add list`; absent renders no affordance. */
  onAddList?: () => void;
}

export function ListsSection({ sourceLists, onOpenList, onAddList }: ListsSectionProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const { shown, showAllCount } = peekRows(sourceLists, expanded);

  return (
    <SectionFrame label="Lists" testID="section-lists">
      {shown.map((summary) => (
        <Touchable
          key={summary.listId}
          accessibilityRole="button"
          accessibilityLabel={`${summary.title}, ${sourceListLine(summary)}`}
          onPress={() => onOpenList(summary.listId)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
            minHeight: theme.layout.hitTarget,
          }}
          testID={`plan-list-${summary.listId}`}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="body" color="textPrimary" numberOfLines={1}>
              {summary.title}
            </Text>
          </View>
          <Text variant="footnote" color="textSecondary">
            {sourceListLine(summary)}
          </Text>
        </Touchable>
      ))}
      {showAllCount === undefined ? null : (
        <ActionRow
          label={`Show all ${showAllCount}`}
          accessibilityLabel={`Show all ${showAllCount}`}
          onPress={() => setExpanded(true)}
          testID="lists-show-all"
        />
      )}
      {onAddList === undefined ? null : (
        <ActionRow
          label="+ Add list"
          accessibilityLabel="Add list"
          onPress={onAddList}
          testID="lists-add"
        />
      )}
    </SectionFrame>
  );
}
