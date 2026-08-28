import { Text, Touchable, useTheme } from '@od/ui';
import { useCallback } from 'react';
import { View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import {
  ReduceMotion,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useSharedValue,
} from 'react-native-reanimated';
import {
  type ListSwipeAction,
  listAccessibilityActions,
  mayCommitOnFullSwipe,
} from '../model/listSwipeActions';
import { ListItemRow, type ListItemRowProps } from './ListItemRow';

/**
 * Native swipe gestures for one `watch` item row (`interaction-contract.md` §3.2, §6.2).
 *
 * `Mark watched` · `Delete` on swipe left, and a full swipe commits `Mark watched` — the one
 * full-swipe commit §3.2 gives an item row, and it is offered because that action is not
 * destructive: it is §8.1's any→any status change with a six-second undo behind it.
 *
 * ## Why this is not `SwipeableListCard`
 *
 * That component is typed around `ListIndexRowProps` and wraps a card, not an item row; the
 * *pattern* is what is shared, which is the same relationship it has with the agenda's
 * `SwipeableRow`. The full-swipe reaction is the agenda's, because the index has none.
 *
 * ## An action with no handler is not rendered
 *
 * `Delete` on an item row belongs to the task that owns the item delete and its undo (P3-29,
 * not on `main`). The caller supplies the handlers it has, and an action nothing can perform is
 * absent rather than present and inert — the same rule this feature applies to every control it
 * cannot yet offer. `watchItemSwipeActions()` still states §3.2's full pair and its order, so
 * the seam is one prop rather than a rewrite.
 */

const ACTION_WIDTH = 88;
const FULL_SWIPE_OVERSHOOT = 72;

export interface SwipeableWatchRowProps extends ListItemRowProps {
  actions: readonly ListSwipeAction[];
  onAction: (action: ListSwipeAction) => void;
}

function ActionPanel({
  actions,
  translation,
  methods,
  onAction,
}: {
  actions: readonly ListSwipeAction[];
  translation: SharedValue<number>;
  methods: SwipeableMethods;
  onAction: (action: ListSwipeAction) => void;
}) {
  const theme = useTheme();
  const armed = useSharedValue(false);
  const first = actions[0];
  const mayCommitFull = mayCommitOnFullSwipe(actions);
  const fullSwipeDistance = actions.length * ACTION_WIDTH + FULL_SWIPE_OVERSHOOT;

  const commit = useCallback(
    (selected: ListSwipeAction) => {
      // Closed before dispatch, so the toast does not appear over a row still holding its
      // translation — the arrangement `SwipeableListCard` records for the same reason.
      methods.close();
      onAction(selected);
    },
    [methods, onAction],
  );

  useAnimatedReaction(
    () => mayCommitFull && Math.abs(translation.value) >= fullSwipeDistance,
    (pastThreshold) => {
      if (pastThreshold && !armed.value && first !== undefined) {
        armed.value = true;
        runOnJS(commit)(first);
      } else if (!pastThreshold) {
        armed.value = false;
      }
    },
    [commit, first, fullSwipeDistance, mayCommitFull],
  );

  return (
    <View
      style={{ minHeight: '100%', flexDirection: 'row-reverse', alignItems: 'stretch' }}
    >
      {actions.map((selected) => (
        <Touchable
          key={selected.name}
          accessibilityRole="button"
          accessibilityLabel={selected.label}
          onPress={() => commit(selected)}
          testID={`list-item-swipe-${selected.name}`}
          style={{
            width: ACTION_WIDTH,
            minHeight: theme.layout.rowMinHeight,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: theme.space[2],
            backgroundColor: selected.destructive
              ? theme.colors.danger
              : theme.colors.accentDeep,
          }}
        >
          <Text variant="footnoteStrong" color="inverse" align="center">
            {selected.label}
          </Text>
        </Touchable>
      ))}
    </View>
  );
}

export function SwipeableWatchRow({
  actions,
  onAction,
  ...rowProps
}: SwipeableWatchRowProps) {
  const accessibilityActions = listAccessibilityActions(actions);

  return (
    <ReanimatedSwipeable
      enabled={actions.length > 0}
      testID={`swipeable-item-${rowProps.item.itemId}`}
      friction={1}
      overshootFriction={1}
      // Overshoot only where a full swipe means something, which is §3.2's own rule.
      overshootRight={mayCommitOnFullSwipe(actions)}
      animationOptions={{ reduceMotion: ReduceMotion.System }}
      {...(actions.length === 0
        ? {}
        : {
            renderRightActions: (
              _progress: SharedValue<number>,
              translation: SharedValue<number>,
              methods: SwipeableMethods,
            ) => (
              <ActionPanel
                actions={actions}
                translation={translation}
                methods={methods}
                onAction={onAction}
              />
            ),
          })}
    >
      <View
        accessibilityActions={[...accessibilityActions]}
        onAccessibilityAction={({ nativeEvent }) => {
          const selected = actions.find(({ name }) => name === nativeEvent.actionName);
          if (selected !== undefined) onAction(selected);
        }}
      >
        <ListItemRow {...rowProps} />
      </View>
    </ReanimatedSwipeable>
  );
}
