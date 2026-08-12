import { Text, Touchable, useTheme } from '@od/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  type AgendaSwipeAction,
  type AgendaSwipeActionName,
  agendaAccessibilityActions,
  agendaSwipeActions,
  allAgendaSwipeActions,
} from '@/features/agenda/model/swipeActions';
import { AgendaRow, type AgendaRowProps } from './AgendaRow';

export interface SwipeableRowProps extends AgendaRowProps {
  onAction?: (item: AgendaRowProps['item'], action: AgendaSwipeAction) => void;
}

const editableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA'
  );
};

/** Web uses hover/focus controls and keyboard shortcuts in place of swipe gestures. */
export function SwipeableRow({ item, onAction, ...rowProps }: SwipeableRowProps) {
  const theme = useTheme();
  const actions = useMemo(() => agendaSwipeActions(item), [item]);
  const allActions = useMemo(() => allAgendaSwipeActions(actions), [actions]);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [rowFocused, setRowFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const controlsVisible = hovered || focusWithin || rowFocused || menuOpen;

  const dispatch = useCallback(
    (selected: AgendaSwipeAction) => onAction?.(item, selected),
    [item, onAction],
  );

  const findAction = useCallback(
    (name: AgendaSwipeActionName) =>
      allActions.find((candidate) => candidate.name === name),
    [allActions],
  );

  useEffect(() => {
    if (!rowFocused) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        editableTarget(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      const selected =
        key === 'e'
          ? actions.positive[0]
          : key === 's'
            ? (findAction('snooze') ?? findAction('schedule'))
            : key === 'd'
              ? findAction('reschedule')
              : key === 'delete' || key === 'backspace'
                ? findAction('delete')
                : undefined;

      if (selected === undefined) return;
      event.preventDefault();
      dispatch(selected);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [actions.positive, dispatch, findAction, rowFocused]);

  const accessibilityActions = agendaAccessibilityActions(actions);
  const positive = actions.positive[0];

  return (
    <View
      testID={`swipeable-row-${item.activityId}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{ position: 'relative' }}
    >
      <AgendaRow
        {...rowProps}
        item={item}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={({ nativeEvent }) => {
          const selected = allActions.find(({ name }) => name === nativeEvent.actionName);
          if (selected !== undefined) dispatch(selected);
        }}
        onBodyFocus={() => setRowFocused(true)}
        onBodyBlur={() => setRowFocused(false)}
      />

      <View
        testID="agenda-web-controls"
        aria-hidden={!controlsVisible}
        accessibilityElementsHidden={!controlsVisible}
        importantForAccessibility={controlsVisible ? 'auto' : 'no-hide-descendants'}
        style={{
          position: 'absolute',
          top: theme.space[2],
          right: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[2],
          padding: theme.space[2],
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surfaceRaised,
          opacity: controlsVisible ? 1 : 0,
          pointerEvents: controlsVisible ? 'auto' : 'none',
          zIndex: 2,
        }}
      >
        {positive === undefined ? null : (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={positive.label}
            onFocus={() => setFocusWithin(true)}
            onBlur={() => setFocusWithin(false)}
            onPress={() => dispatch(positive)}
            testID="agenda-web-positive-action"
            style={{
              minHeight: theme.layout.hitTarget,
              paddingHorizontal: theme.space[4],
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.success,
              alignItems: 'center',
            }}
          >
            <Text variant="footnoteStrong" color="inverse">
              {positive.label}
            </Text>
          </Touchable>
        )}

        {actions.secondary.length === 0 ? null : (
          <Touchable
            square
            accessibilityRole="button"
            accessibilityLabel={`More actions for ${item.title}`}
            onFocus={() => setFocusWithin(true)}
            onBlur={() => setFocusWithin(false)}
            onPress={() => setMenuOpen((open) => !open)}
            testID="agenda-web-more-actions"
            style={{
              alignItems: 'center',
              borderRadius: theme.radius.pill,
              borderWidth: 1,
              borderColor: theme.colors.borderStrong,
              backgroundColor: theme.colors.surfaceRaised,
            }}
          >
            <Text variant="title" color="textPrimary">
              ⋯
            </Text>
          </Touchable>
        )}
      </View>

      {menuOpen ? (
        <View
          accessibilityRole="menu"
          accessibilityLabel={`Actions for ${item.title}`}
          testID="agenda-web-action-menu"
          style={{
            position: 'absolute',
            top: theme.layout.rowMinHeight - theme.space[1],
            right: 0,
            minWidth: 180,
            gap: theme.space[2],
            padding: theme.space[3],
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: theme.colors.borderStrong,
            backgroundColor: theme.colors.surfaceOverlay,
            zIndex: 3,
          }}
        >
          {actions.secondary.map((selected) => (
            <Touchable
              key={selected.name}
              accessibilityRole="menuitem"
              accessibilityLabel={selected.label}
              onPress={() => {
                setMenuOpen(false);
                dispatch(selected);
              }}
              testID={`agenda-menu-${selected.name}`}
              style={{
                minHeight: theme.layout.hitTarget,
                paddingHorizontal: theme.space[4],
                borderRadius: theme.radius.md,
                borderWidth: selected.destructive ? 0 : 1,
                borderColor: theme.colors.borderStrong,
                backgroundColor: selected.destructive
                  ? theme.colors.danger
                  : theme.colors.surfaceRaised,
                alignItems: 'center',
              }}
            >
              <Text
                variant="bodyStrong"
                color={selected.destructive ? 'inverse' : 'textPrimary'}
              >
                {selected.label}
              </Text>
            </Touchable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
