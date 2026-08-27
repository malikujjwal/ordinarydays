import { Text, Touchable, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { listAccessibilityActions } from '../model/listSwipeActions';
import { ListIndexRow, type ListIndexRowProps } from './ListIndexRow';
import type { SwipeableListCardProps } from './SwipeableListCard';

/**
 * The web equivalent of the index row's swipe actions.
 *
 * There is no swipe on a pointer device, so §3.2's gestures become **hover- and
 * focus-revealed controls** — the same substitution `features/agenda`'s web row makes. What
 * must not change across platforms is reachability: the actions are also `accessibilityActions`
 * on the card, so a keyboard or screen-reader user gets them whether or not anything is
 * hovered.
 *
 * Deliberately simpler than the agenda's web row, which registers document-level keyboard
 * shortcuts. Those exist because Today is the screen a user lives on and completes rows from
 * all day; the Lists index is a place you pass through on the way to a list, and a global
 * single-key binding for `Delete` on it would be a hazard rather than an affordance.
 */

export type { SwipeableListCardProps };

export function SwipeableListCard({
  actions,
  onAction,
  ...rowProps
}: SwipeableListCardProps) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const visible = actions.length > 0 && (hovered || focusWithin);
  const accessibilityActions = listAccessibilityActions(actions);

  return (
    <View
      testID={`swipeable-list-${rowProps.list.listId}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      // React Native Web projects these onto the DOM node, so tabbing to any control inside
      // the card reveals the row's own actions rather than hiding them under the focus ring.
      onFocus={() => setFocusWithin(true)}
      onBlur={() => setFocusWithin(false)}
      style={{ position: 'relative' }}
      accessibilityActions={[...accessibilityActions]}
      onAccessibilityAction={({ nativeEvent }) => {
        const selected = actions.find(({ name }) => name === nativeEvent.actionName);
        if (selected !== undefined) onAction(selected);
      }}
    >
      <ListIndexRow {...(rowProps as ListIndexRowProps)} />
      {visible ? (
        <View
          style={{
            position: 'absolute',
            top: theme.space[2],
            right: theme.space[2],
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
              testID={`list-swipe-${action.name}`}
              style={{
                paddingHorizontal: theme.space[3],
                paddingVertical: theme.space[2],
                borderRadius: theme.radius.sm,
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
