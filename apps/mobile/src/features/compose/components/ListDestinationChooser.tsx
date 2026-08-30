import { EmptyState, SettingRow, Skeleton, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * Required inline destination section for the global List-item composer (§P3-33).
 *
 * The rows stay in server pointer order and nothing is inferred or preselected. `New list`
 * remains last so returning from creation can visibly select the explicit new destination.
 */
export interface ListDestination {
  readonly listId: string;
  readonly title: string;
}

export interface ListDestinationChooserProps {
  lists: readonly ListDestination[];
  status: 'pending' | 'success' | 'error';
  selectedListId?: string;
  onChoose: (listId: string) => void;
  onCreateList: () => void;
  onRetry: () => void;
}

export function ListDestinationChooser({
  lists,
  status,
  selectedListId,
  onChoose,
  onCreateList,
  onRetry,
}: ListDestinationChooserProps) {
  const theme = useTheme();

  return (
    <View testID="list-destination-chooser" style={{ gap: theme.space[3] }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
        }}
      >
        <Text variant="bodyStrong" accessibilityRole="header">
          Add to
        </Text>
        <Text variant="footnote" color="textSecondary">
          Required
        </Text>
      </View>

      {status === 'pending' ? (
        <View testID="list-destination-loading">
          <Skeleton shape="row" count={4} />
        </View>
      ) : status === 'error' && lists.length === 0 ? (
        <EmptyState
          heading="Couldn't load this."
          action={{ label: 'Try again', onPress: onRetry }}
          testID="list-destination-error"
        />
      ) : (
        <View>
          {lists.map((list) => (
            <SettingRow
              key={list.listId}
              label={list.title}
              summary="Add this item to this list"
              selected={selectedListId === list.listId}
              accessibilityLabel={`${list.title}, select as destination`}
              onPress={() => onChoose(list.listId)}
              testID={`list-destination-${list.listId}`}
            />
          ))}
          <SettingRow
            label="New list"
            summary="Choose a type, then name it"
            accessibilityLabel="New list, Choose a type, then name it"
            opens
            onPress={onCreateList}
            testID="list-destination-new"
          />
        </View>
      )}
    </View>
  );
}
