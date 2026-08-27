import { EmptyState, Skeleton, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { ChooserRow } from '@/features/compose/components/ChooserRow';

/**
 * `List item`'s required second choice: **which list** (`activities.md` §2.2, §P3-27,
 * criterion 33).
 *
 * ```
 * Which list?
 *
 * Groceries                     ›
 * Packing                       ›
 * Restaurants to try            ›
 *
 * New list                      ›
 * ```
 *
 * ## Nothing chooses for the user, and there is no prop through which anything could
 *
 * The rows are the lists in the **server's own pointer order**, unfiltered and unsorted.
 * No `defaultLists`, no most-recently-used, no behaviour or template metadata, and no title —
 * the title does not exist yet, because this step comes before any field (ADR-033, ADR-046).
 * `defaultLists` belongs to named flows like `Add ingredients to:` and is not reachable from
 * here.
 *
 * The component takes `lists` and calls back. It has no hook, no query and no store, which is
 * also what keeps `no-cross-feature-imports` satisfied: the compose feature cannot read the
 * lists feature's data, so the **route** — the one place allowed to see both — supplies it.
 *
 * ## `New list` is a row, not a fallback
 *
 * §5.4 rule 5: creating from here returns to this form with the new list visibly selected. It
 * sits after the lists rather than before them, because it is the answer to "none of these"
 * and putting it first would make the common case scroll.
 */
export interface ListDestination {
  readonly listId: string;
  readonly title: string;
}

export interface ListDestinationChooserProps {
  lists: readonly ListDestination[];
  status: 'pending' | 'success' | 'error';
  onChoose: (listId: string) => void;
  onCreateList: () => void;
  onRetry: () => void;
}

export function ListDestinationChooser({
  lists,
  status,
  onChoose,
  onCreateList,
  onRetry,
}: ListDestinationChooserProps) {
  const theme = useTheme();

  return (
    <View testID="list-destination-chooser" style={{ gap: theme.space[5] }}>
      <Text variant="title" color="textDisplay" accessibilityRole="header">
        Which list?
      </Text>

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
            <ChooserRow
              key={list.listId}
              label={list.title}
              subtitle="Add this item to this list"
              onPress={() => onChoose(list.listId)}
              testID={`list-destination-${list.listId}`}
            />
          ))}
          <ChooserRow
            label="New list"
            subtitle="Choose a style, then name it"
            onPress={onCreateList}
            testID="list-destination-new"
          />
        </View>
      )}
    </View>
  );
}
