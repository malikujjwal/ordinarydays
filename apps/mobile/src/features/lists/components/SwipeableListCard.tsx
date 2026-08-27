import { Text, Touchable, useTheme } from '@od/ui';
import { useCallback } from 'react';
import { View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import { ReduceMotion, type SharedValue } from 'react-native-reanimated';
import {
  type ListSwipeAction,
  listAccessibilityActions,
} from '../model/listSwipeActions';
import { ListIndexRow, type ListIndexRowProps } from './ListIndexRow';

/**
 * Native swipe gestures for one Lists-index card (`interaction-contract.md` §3.2, §6).
 *
 * ## Why this is not `features/agenda`'s `SwipeableRow`
 *
 * That component is typed around `AgendaRowProps`, and reaches into agenda's completion-commit
 * lock, its pending-intent state and its swipe-action model. None of those exist for a list
 * row, and `check-forbidden.mjs`'s `client-layer-rules` forbids one feature importing another's
 * internals anyway. What is shared is the *pattern*, which is what this follows.
 *
 * ## Left-swipe only, and no full-swipe commit
 *
 * §3.2 gives the index row `Archive` · `Delete` on swipe left and nothing on swipe right or
 * long press. Neither column has a full-swipe shortcut: `Delete` is destructive and takes the
 * §1a.1 confirmation, and `Archive` is not offered as one either — a card that vanished on an
 * over-swipe would be the one gesture on this screen that acts without a tap.
 */

const ACTION_WIDTH = 88;

export interface SwipeableListCardProps extends ListIndexRowProps {
  actions: readonly ListSwipeAction[];
  onAction: (action: ListSwipeAction) => void;
}

function ActionPanel({
  actions,
  methods,
  onAction,
}: {
  actions: readonly ListSwipeAction[];
  methods: SwipeableMethods;
  onAction: (action: ListSwipeAction) => void;
}) {
  const theme = useTheme();
  const commit = useCallback(
    (selected: ListSwipeAction) => {
      // Closed before dispatch, so a confirmation dialog does not open over an open row that
      // is still holding its translation.
      methods.close();
      onAction(selected);
    },
    [methods, onAction],
  );

  return (
    <View
      style={{
        minHeight: '100%',
        flexDirection: 'row-reverse',
        alignItems: 'stretch',
      }}
    >
      {actions.map((selected) => (
        <Touchable
          key={selected.name}
          accessibilityRole="button"
          accessibilityLabel={selected.label}
          onPress={() => commit(selected)}
          testID={`list-swipe-${selected.name}`}
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

export function SwipeableListCard({
  actions,
  onAction,
  ...rowProps
}: SwipeableListCardProps) {
  const accessibilityActions = listAccessibilityActions(actions);

  return (
    <ReanimatedSwipeable
      enabled={actions.length > 0}
      testID={`swipeable-list-${rowProps.list.listId}`}
      friction={1}
      overshootFriction={1}
      // No overshoot on either side: nothing here commits on a full swipe.
      overshootRight={false}
      animationOptions={{ reduceMotion: ReduceMotion.System }}
      {...(actions.length === 0
        ? {}
        : {
            renderRightActions: (
              _progress: SharedValue<number>,
              _translation: SharedValue<number>,
              methods: SwipeableMethods,
            ) => <ActionPanel actions={actions} methods={methods} onAction={onAction} />,
          })}
    >
      <View
        accessibilityActions={[...accessibilityActions]}
        onAccessibilityAction={({ nativeEvent }) => {
          const selected = actions.find(({ name }) => name === nativeEvent.actionName);
          if (selected !== undefined) onAction(selected);
        }}
      >
        <ListIndexRow {...rowProps} />
      </View>
    </ReanimatedSwipeable>
  );
}
