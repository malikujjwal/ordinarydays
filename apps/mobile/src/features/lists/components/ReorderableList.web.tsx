import { GripVertical, type Theme, Touchable, useTheme } from '@od/ui';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { dropIndex, REORDER_LONG_PRESS_MS, type ReorderRange } from '../model/reorder';
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

interface PendingLongPress {
  readonly itemId: string;
  readonly index: number;
  readonly range: ReorderRange;
  readonly pointerY: number;
  readonly timer: ReturnType<typeof setTimeout>;
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

const TOUCH_LAYOUT_QUERY = '(hover: none), (pointer: coarse)';

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    row: { position: 'relative', zIndex: 0 },
    rowRaised: { zIndex: 2 },
    rowLeading: { paddingLeft: theme.layout.hitTarget },
    rowTrailing: { paddingRight: theme.layout.hitTarget },
    rowSurface: { backgroundColor: theme.colors.surface },
    rowQuiet: { backgroundColor: 'transparent' },
    handleSlot: {
      position: 'absolute',
      top: '50%',
      marginTop: -theme.layout.hitTarget / 2,
      pointerEvents: 'auto',
      zIndex: 3,
    },
    handleLeading: { left: 0 },
    handleTrailing: { right: 0 },
    handleVisible: { opacity: 1 },
    handleHidden: { opacity: 0 },
    handle: {
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: theme.radius.pill,
      borderWidth: 1,
    },
    handleSurface: {
      borderColor: theme.colors.borderStrong,
      backgroundColor: theme.colors.surfaceRaised,
    },
    handleQuiet: {
      borderColor: 'transparent',
      backgroundColor: 'transparent',
    },
  });

function useTouchLayout(): boolean {
  const [touch, setTouch] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(TOUCH_LAYOUT_QUERY).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(TOUCH_LAYOUT_QUERY);
    const update = () => setTouch(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return touch;
}

export function ReorderableList<T>({
  items,
  keyOf,
  labelOf,
  rangeOf,
  onDrop,
  renderItem,
  handlePlacement = 'trailing',
  handleAppearance = 'surface',
  handleVisibility = 'adaptive',
  testID,
}: ReorderableListProps<T>) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const owner = useId();
  const touchLayout = useTouchLayout();
  const [hovered, setHovered] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const [held, setHeld] = useState<RowState>();
  const heights = useRef<number[]>([]);
  /** The live row, for window listeners that must not close over a stale render. */
  const live = useRef<RowState | undefined>(undefined);
  live.current = held;
  const pendingLongPress = useRef<PendingLongPress | undefined>(undefined);
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
    const clearPending = () => {
      const pending = pendingLongPress.current;
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      pendingLongPress.current = undefined;
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const row = event.target.closest<HTMLElement>('[data-testid^="list-reorder-row-"]');
      if (
        row === null ||
        row.closest<HTMLElement>('[id^="reorder-"]')?.id !== `reorder-${owner}`
      )
        return;
      const itemId = row.dataset.testid?.replace('list-reorder-row-', '');
      if (itemId === undefined) return;
      const index = indices.current.get(itemId);
      const range = rangeOf(itemId);
      if (index === undefined || range === undefined) return;

      const touchPointer = event.pointerType === 'touch' || event.pointerType === 'pen';
      if (touchPointer) {
        clearPending();
        const timer = setTimeout(() => {
          const pending = pendingLongPress.current;
          if (pending?.itemId !== itemId) return;
          pendingLongPress.current = undefined;
          const next = {
            itemId,
            index,
            toIndex: index,
            range,
            pointerY: pending.pointerY,
          };
          live.current = next;
          setHeld(next);
        }, REORDER_LONG_PRESS_MS);
        pendingLongPress.current = {
          itemId,
          index,
          range,
          pointerY: event.pageY,
          timer,
        };
        return;
      }

      const handle = event.target.closest<HTMLElement>(
        '[data-testid^="list-reorder-handle-"]',
      );
      if (handle === null) return;
      const next = { itemId, index, toIndex: index, range, pointerY: event.pageY };
      live.current = next;
      setHeld(next);
    };
    const onMove = (event: PointerEvent) => {
      const pending = pendingLongPress.current;
      if (pending !== undefined && Math.abs(event.pageY - pending.pointerY) > 8) {
        clearPending();
      }
      const current = live.current;
      if (current?.pointerY === undefined) return;
      const translationY = event.pageY - current.pointerY;
      const next = clamp(
        dropIndex(heights.current, current.index, translationY),
        current.range,
      );
      if (next !== current.toIndex) {
        const moved = { ...current, toIndex: next };
        live.current = moved;
        setHeld(moved);
      }
    };
    const onUp = (event: PointerEvent) => {
      clearPending();
      if (live.current?.pointerY === undefined) return;
      // Prevent the synthetic click after a long press from also opening the item sheet.
      event.preventDefault();
      finish(true);
    };
    const onCancel = () => {
      clearPending();
      if (live.current?.pointerY !== undefined) finish(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      clearPending();
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [finish, owner, rangeOf]);

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
    <View nativeID={`reorder-${owner}`} testID={testID}>
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
        const handleVisible =
          handleVisibility === 'persistent' ||
          touchLayout ||
          hovered === itemId ||
          focused === itemId ||
          grabbed !== undefined;

        return (
          <View
            key={itemId}
            testID={`list-reorder-row-${itemId}`}
            onLayout={(event) => {
              heights.current[index] = event.nativeEvent.layout.height;
            }}
            onPointerEnter={() => setHovered(itemId)}
            onPointerLeave={() =>
              setHovered((current) => (current === itemId ? undefined : current))
            }
            style={[
              styles.row,
              range === undefined
                ? null
                : handlePlacement === 'leading'
                  ? styles.rowLeading
                  : styles.rowTrailing,
              handleAppearance === 'quiet' ? styles.rowQuiet : styles.rowSurface,
              // The translation is the only per-row style value; it is live drag state.
              { transform: [{ translateY: shift }] },
              grabbed === undefined ? null : styles.rowRaised,
            ]}
          >
            {renderItem(item, index)}

            {range === undefined ? null : (
              <View
                style={[
                  styles.handleSlot,
                  handlePlacement === 'leading'
                    ? styles.handleLeading
                    : styles.handleTrailing,
                  handleVisible ? styles.handleVisible : styles.handleHidden,
                  /*
                   * Never `display: none` and never removed: the handle stays in the tab order
                   * so a keyboard user can reach a control a pointer user reveals by hovering.
                   */
                ]}
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
                  testID={`list-reorder-handle-${itemId}`}
                  style={[
                    styles.handle,
                    handleAppearance === 'quiet'
                      ? styles.handleQuiet
                      : styles.handleSurface,
                  ]}
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
