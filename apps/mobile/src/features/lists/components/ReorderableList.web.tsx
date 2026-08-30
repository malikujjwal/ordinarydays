import { GripVertical, Touchable, useTheme } from '@od/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { dropIndex, type ReorderRange } from '../model/reorder';
import type { ReorderableListProps } from './ReorderableList';

/**
 * §7.1's hover drag handle, and the keyboard path that must exist beside it (§P3-30).
 *
 * The native file beside this one is the long-press drag. Web replaces the gesture rather than
 * the behaviour: the same `onDrop(itemId, toIndex)` reaches the same hook, so the connectivity
 * gate, the single request and the revert are one implementation on both platforms.
 *
 * ## The handle is not the only path
 *
 * §7.1 ends with a rule the drag handle would otherwise break: "hover-revealed controls are
 * always **also** reachable by keyboard and are never the only path to an action." A pointer
 * drag is unreachable without a pointer, so the handle is a focusable button that **grabs** the
 * row: `Return` or `Space` picks it up, `↑`/`↓` move it, `Return`/`Space` drop it, `Escape`
 * puts it back. That is one drag and one request, exactly as the pointer produces — not one
 * request per keypress.
 *
 * `↑`/`↓` are §7.2's "move focus between rows" everywhere else, and they still are: the
 * override applies only while a row is grabbed, which is a mode the user entered deliberately
 * and can leave with `Escape`.
 *
 * ## The clamp is the grouped-stage guard
 *
 * `rangeOf` bounds every target, pointer and keyboard alike, so a grouped-stage row cannot be
 * carried past its own state heading. Dragging across one would change intrinsic state by
 * gesture, which no spec grants.
 */

interface RowState {
  readonly itemId: string;
  readonly index: number;
  readonly toIndex: number;
  readonly range: ReorderRange;
  /** Present for a pointer drag; absent while the row is held by the keyboard. */
  readonly pointerY?: number;
}

const clamp = (value: number, range: ReorderRange): number =>
  Math.min(Math.max(value, range.first), range.last);

/** How far a row has visually travelled to reach `toIndex`, from the heights it passed. */
function travel(heights: readonly number[], from: number, to: number): number {
  if (to === from) return 0;
  let distance = 0;
  if (to > from) {
    for (let at = from + 1; at <= to; at += 1) distance += heights[at] ?? 0;
  } else {
    for (let at = to; at < from; at += 1) distance -= heights[at] ?? 0;
  }
  return distance;
}

export function ReorderableList<T>({
  items,
  keyOf,
  labelOf,
  rangeOf,
  onDrop,
  renderItem,
  testID,
}: ReorderableListProps<T>) {
  const theme = useTheme();
  const [hovered, setHovered] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const [held, setHeld] = useState<RowState>();
  const heights = useRef<number[]>([]);
  /** The live row, for window listeners that must not close over a stale render. */
  const live = useRef<RowState | undefined>(undefined);
  live.current = held;
  /** Each row's current position, so the keyboard listener can name one from its id alone. */
  const indices = useRef(new Map<string, number>());
  indices.current = new Map(items.map((item, index) => [keyOf(item), index]));

  const finish = useCallback(
    (commit: boolean) => {
      const current = live.current;
      live.current = undefined;
      setHeld(undefined);
      if (current !== undefined && commit) onDrop(current.itemId, current.toIndex);
    },
    [onDrop],
  );

  useEffect(() => {
    if (held?.pointerY === undefined) return;
    const onMove = (event: PointerEvent) => {
      const current = live.current;
      if (current?.pointerY === undefined) return;
      const translationY = event.pageY - current.pointerY;
      const next = clamp(
        dropIndex(heights.current, current.index, translationY),
        current.range,
      );
      if (next !== current.toIndex) setHeld({ ...current, toIndex: next });
    };
    const onUp = () => finish(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', () => finish(false));
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [finish, held?.pointerY]);

  /**
   * One `keydown` listener for every handle, dispatched by which one has focus.
   *
   * The same arrangement `SwipeableRow.web.tsx` uses, and for its reason: React Native does not
   * declare a `onKeyDown` prop, so a per-control prop would depend on the web renderer
   * forwarding one it was never typed for.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return;
      const handle = active.closest<HTMLElement>('[data-testid^="list-reorder-handle-"]');
      if (handle === null) return;
      const itemId = handle.dataset.testid?.replace('list-reorder-handle-', '');
      if (itemId === undefined) return;
      const index = indices.current.get(itemId);
      const range = rangeOf(itemId);
      if (index === undefined || range === undefined) return;
      const current = live.current?.itemId === itemId ? live.current : undefined;

      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        if (current === undefined) setHeld({ itemId, index, toIndex: index, range });
        else finish(true);
        return;
      }
      if (current === undefined) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        // §7.2's row-focus keys, overridden only while a row is deliberately held.
        event.preventDefault();
        setHeld({
          ...current,
          toIndex: clamp(current.toIndex + (event.key === 'ArrowUp' ? -1 : 1), range),
        });
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [finish, rangeOf]);

  return (
    <View testID={testID}>
      {items.map((item, index) => {
        const itemId = keyOf(item);
        const itemLabel = labelOf(item);
        const range = rangeOf(itemId);
        const grabbed = held?.itemId === itemId ? held : undefined;
        const handleDescription =
          grabbed === undefined
            ? `Position ${String(index + 1)} of ${String(items.length)}. Move up and Move down actions available.`
            : `Moving, position ${String(grabbed.toIndex + 1)} of ${String(items.length)}. Arrow keys to move, Return to drop, Escape to cancel.`;
        const shift =
          grabbed !== undefined
            ? travel(heights.current, grabbed.index, grabbed.toIndex)
            : held === undefined
              ? 0
              : /* A neighbour steps aside by exactly the held row's height. */
                index > held.index && index <= held.toIndex
                ? -(heights.current[held.index] ?? 0)
                : index < held.index && index >= held.toIndex
                  ? (heights.current[held.index] ?? 0)
                  : 0;

        return (
          <View
            key={itemId}
            onLayout={(event) => {
              heights.current[index] = event.nativeEvent.layout.height;
            }}
            onPointerEnter={() => setHovered(itemId)}
            onPointerLeave={() =>
              setHovered((current) => (current === itemId ? undefined : current))
            }
            style={{
              position: 'relative',
              ...(range === undefined ? {} : { paddingRight: theme.layout.hitTarget }),
              backgroundColor: theme.colors.surface,
              transform: [{ translateY: shift }],
              zIndex: grabbed === undefined ? 0 : 2,
            }}
          >
            {renderItem(item, index)}

            {range === undefined ? null : (
              <View
                style={{
                  position: 'absolute',
                  top: theme.space[2],
                  right: 0,
                  opacity:
                    hovered === itemId || focused === itemId || grabbed !== undefined
                      ? 1
                      : 0,
                  /*
                   * Never `display: none` and never removed: the handle stays in the tab order
                   * so a keyboard user can reach a control a pointer user reveals by hovering.
                   */
                  pointerEvents: 'auto',
                  zIndex: 3,
                }}
              >
                <Touchable
                  square
                  accessibilityRole="button"
                  accessibilityLabel={`Reorder ${itemLabel}`}
                  accessibilityHint={handleDescription}
                  dataSet={{ reorderDescription: handleDescription }}
                  accessibilityState={{ selected: grabbed !== undefined }}
                  accessibilityActions={[
                    { name: 'decrement', label: 'Move up' },
                    { name: 'increment', label: 'Move down' },
                  ]}
                  onAccessibilityAction={(event) => {
                    const delta = event.nativeEvent.actionName === 'decrement' ? -1 : 1;
                    const next = clamp(index + delta, range);
                    if (next !== index) onDrop(itemId, next);
                  }}
                  onFocus={() => setFocused(itemId)}
                  onBlur={() =>
                    setFocused((current) => (current === itemId ? undefined : current))
                  }
                  /*
                   * `onPressIn` rather than `onPointerDown`: it is the prop React Native
                   * actually declares, it fires on pointer down on the web build, and its
                   * `pageY` is in the same frame as the `pointermove` listener above — mixing
                   * page and client coordinates would put the drop in the wrong gap on a
                   * scrolled page.
                   */
                  onPressIn={(event) => {
                    const bounds = rangeOf(itemId);
                    if (bounds === undefined) return;
                    setHeld({
                      itemId,
                      index,
                      toIndex: index,
                      range: bounds,
                      pointerY: event.nativeEvent.pageY,
                    });
                  }}
                  testID={`list-reorder-handle-${itemId}`}
                  style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: theme.radius.pill,
                    borderWidth: 1,
                    borderColor: theme.colors.borderStrong,
                    backgroundColor: theme.colors.surfaceRaised,
                  }}
                >
                  <GripVertical size={20} color={theme.colors.textSecondary} />
                </Touchable>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
