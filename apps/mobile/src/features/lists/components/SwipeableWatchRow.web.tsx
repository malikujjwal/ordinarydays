import { Text, Touchable, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { listAccessibilityActions } from '../model/listSwipeActions';
import { ListItemRow, type ListItemRowProps } from './ListItemRow';
import type { SwipeableWatchRowProps } from './SwipeableWatchRow';

/**
 * The web equivalent of a `watch` row's swipe actions (§3.2, §7.1).
 *
 * There is no swipe on a pointer device, so the actions become hover- and focus-revealed
 * controls — the substitution `SwipeableListCard.web.tsx` already makes on the index, followed
 * here so the two Lists surfaces behave the same way. There is no full-swipe equivalent to
 * build: a full swipe is a shortcut for the first action, and the first action is already a
 * button here.
 *
 * Reachability is what must not change across platforms, so the actions are also
 * `accessibilityActions` on the row: a keyboard or screen-reader user gets them whether or not
 * anything is hovered, which is §6.2's `Mark watched` on the `watch` list-item row.
 */

export type { SwipeableWatchRowProps };

export function SwipeableWatchRow({
  actions,
  onAction,
  ...rowProps
}: SwipeableWatchRowProps) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const visible = actions.length > 0 && (hovered || focusWithin);
  const accessibilityActions = listAccessibilityActions(actions);

  return (
    <View
      testID={`swipeable-item-${rowProps.item.itemId}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={() => setFocusWithin(false)}
      style={{ position: 'relative' }}
      accessibilityActions={[...accessibilityActions]}
      onAccessibilityAction={({ nativeEvent }) => {
        const selected = actions.find(({ name }) => name === nativeEvent.actionName);
        if (selected !== undefined) onAction(selected);
      }}
    >
      <ListItemRow {...(rowProps as ListItemRowProps)} />
      {visible ? (
        <View
          style={{
            position: 'absolute',
            top: theme.space[2],
            /*
             * Clear of P3-30's drag handle, which occupies the row's right edge on hover. Two
             * hover-revealed controls on one row is what §3.2 and §7.1 between them ask for;
             * overlapping them would make the reorder handle unreachable by pointer.
             */
            right: theme.layout.hitTarget + theme.space[2],
            flexDirection: 'row',
            gap: theme.space[2],
          }}
        >
          {actions.map((action) => (
            <Touchable
              key={action.name}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => onAction(action)}
              testID={`list-item-swipe-${action.name}`}
              style={{
                paddingHorizontal: theme.space[4],
                borderRadius: theme.radius.pill,
                alignItems: 'center',
                backgroundColor: action.destructive
                  ? theme.colors.danger
                  : theme.colors.accentDeep,
              }}
            >
              <Text variant="footnoteStrong" color="inverse">
                {action.label}
              </Text>
            </Touchable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
