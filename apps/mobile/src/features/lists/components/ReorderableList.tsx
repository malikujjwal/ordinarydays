import { GripVertical, useTheme } from '@od/ui';
import type { ReactNode } from 'react';
import { useCallback, useRef } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { dropIndex, REORDER_LONG_PRESS_MS, type ReorderRange } from '../model/reorder';

/**
 * Long-press and drag, on the native thread (§P3-30,
 * [`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.6).
 *
 * Reanimated + gesture-handler, the same stack as the agenda's swipe rows, and for the same
 * reason: the finger has to be tracked without a round trip through JavaScript. The web file
 * beside this one replaces the gesture with §7.1's hover drag handle; the bundler resolves one
 * name, as it does for `SwipeableRow`.
 *
 * ## `activateAfterLongPress`, not a separate long-press gesture
 *
 * The rows live in a `ScrollView`, so a pan that engaged immediately would fight the scroll.
 * Arming the pan behind a long press is what separates the two readings of one downward drag —
 * before the press lands it scrolls, after it the row moves — and it is the gesture-handler
 * expression of the interaction contract's supporting rule.
 *
 * ## Direct manipulation is not decorative motion
 *
 * The dragged row's `translateY` is the finger's, with no animation on it at all, so Reduce
 * Motion changes nothing about the tracking (§6.5). What Reduce Motion **does** govern is the
 * two springs around it: the neighbours moving aside, and the row settling when it is let go.
 * Both carry `ReduceMotion.System`, so the system setting removes them and the rows simply
 * arrive. There is no haptic on drop — haptics are completion and swipe-commit only.
 *
 * ## Heights, because a row is not a fixed height
 *
 * A list row is one line or four — a title, a note, a place, a state line — so the drop index
 * is computed from measured heights rather than a constant. Each row reports its own on layout;
 * `dropIndex` turns the finger's travel into an insertion index.
 */
export interface ReorderableListProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** Human title used by the wrapper-owned handle: `Reorder <title>`. */
  labelOf: (item: T) => string;
  /**
   * The insertion indices this row may be dropped at, or `undefined` when it may not be
   * dragged at all.
   *
   * The clamp is applied to the **hover index** as the finger moves, so a `watch` row cannot be
   * carried past its own status heading even visually — the guard is not merely a refusal at
   * the end of a drag that looked like it would work.
   */
  rangeOf: (itemId: string) => ReorderRange | undefined;
  onDrop: (itemId: string, toIndex: number) => void;
  renderItem: (item: T, index: number) => ReactNode;
  /** Content rows trail; compact nested rows lead with their grip. */
  handlePlacement?: 'leading' | 'trailing';
  /** Nested rows use a neutral grip without the raised pointer chrome. */
  handleAppearance?: 'surface' | 'quiet';
  /** Nested rows keep the grip visible because there is no trailing wrapper-owned handle. */
  handleVisibility?: 'adaptive' | 'persistent';
  testID?: string;
}

interface RowProps {
  index: number;
  itemId: string;
  itemLabel: string;
  range: ReorderRange | undefined;
  heights: SharedValue<number[]>;
  activeIndex: SharedValue<number>;
  hoverIndex: SharedValue<number>;
  translation: SharedValue<number>;
  onMeasured: (index: number, height: number) => void;
  onDrop: (itemId: string, toIndex: number) => void;
  handlePlacement: 'leading' | 'trailing';
  handleAppearance: 'surface' | 'quiet';
  children: ReactNode;
}

/** Reduce Motion removes the settle and the neighbour shift; the tracking is never animated. */
const SETTLE = {
  damping: 20,
  stiffness: 220,
  reduceMotion: ReduceMotion.System,
} as const;

function ReorderableRow({
  index,
  itemId,
  itemLabel,
  range,
  heights,
  activeIndex,
  hoverIndex,
  translation,
  onMeasured,
  onDrop,
  handlePlacement,
  handleAppearance,
  children,
}: RowProps) {
  const theme = useTheme();

  const commit = useCallback(
    (toIndex: number) => {
      onDrop(itemId, toIndex);
    },
    [itemId, onDrop],
  );

  const first = range?.first ?? 0;
  const last = range?.last ?? 0;

  const gesture = Gesture.Pan()
    .enabled(range !== undefined)
    .activateAfterLongPress(REORDER_LONG_PRESS_MS)
    .onStart(() => {
      activeIndex.value = index;
      hoverIndex.value = index;
      translation.value = 0;
    })
    .onUpdate((event) => {
      translation.value = event.translationY;
      const target = dropIndex(heights.value, index, event.translationY);
      // The watch guard, applied to the finger rather than to the drop (§8.1).
      hoverIndex.value = Math.min(Math.max(target, first), last);
    })
    .onEnd(() => {
      runOnJS(commit)(hoverIndex.value);
    })
    .onFinalize(() => {
      activeIndex.value = -1;
      hoverIndex.value = -1;
      translation.value = withSpring(0, SETTLE);
    });

  const style = useAnimatedStyle(() => {
    const active = activeIndex.value;
    if (active === index) {
      return { transform: [{ translateY: translation.value }], zIndex: 2 };
    }
    if (active < 0) return { transform: [{ translateY: 0 }], zIndex: 0 };
    const lift = heights.value[active] ?? 0;
    const hover = hoverIndex.value;
    const shift =
      index > active && index <= hover
        ? -lift
        : index < active && index >= hover
          ? lift
          : 0;
    return { transform: [{ translateY: withSpring(shift, SETTLE) }], zIndex: 0 };
  });

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        onLayout={(event) => onMeasured(index, event.nativeEvent.layout.height)}
        style={[
          style,
          {
            position: 'relative',
            ...(handlePlacement === 'leading'
              ? { paddingLeft: theme.layout.hitTarget }
              : { paddingRight: theme.layout.hitTarget }),
            backgroundColor:
              handleAppearance === 'quiet' ? 'transparent' : theme.colors.surface,
          },
        ]}
      >
        {children}
        {range === undefined ? null : (
          <Animated.View
            accessible
            focusable
            accessibilityRole="button"
            accessibilityLabel={`Reorder ${itemLabel}`}
            accessibilityHint={`Position ${String(index + 1)}. Move up and Move down actions available.`}
            accessibilityActions={[
              { name: 'decrement', label: 'Move up' },
              { name: 'increment', label: 'Move down' },
            ]}
            onAccessibilityAction={(event) => {
              const delta = event.nativeEvent.actionName === 'decrement' ? -1 : 1;
              const next = Math.min(Math.max(index + delta, first), last);
              if (next !== index) onDrop(itemId, next);
            }}
            testID={`list-reorder-handle-${itemId}`}
            style={{
              position: 'absolute',
              top: theme.space[2],
              ...(handlePlacement === 'leading' ? { left: 0 } : { right: 0 }),
              width: theme.layout.hitTarget,
              height: theme.layout.hitTarget,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <GripVertical size={20} color={theme.colors.textSecondary} />
          </Animated.View>
        )}
      </Animated.View>
    </GestureDetector>
  );
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
  testID,
}: ReorderableListProps<T>) {
  const heights = useSharedValue<number[]>([]);
  const activeIndex = useSharedValue(-1);
  const hoverIndex = useSharedValue(-1);
  const translation = useSharedValue(0);
  /** The JS-side copy the shared value is rebuilt from; layout arrives one row at a time. */
  const measured = useRef<number[]>([]);

  const onMeasured = useCallback(
    (index: number, height: number) => {
      if (measured.current[index] === height) return;
      measured.current[index] = height;
      heights.value = [...measured.current];
    },
    [heights],
  );

  return (
    <Animated.View testID={testID}>
      {items.map((item, index) => {
        const itemId = keyOf(item);
        return (
          <ReorderableRow
            key={itemId}
            index={index}
            itemId={itemId}
            itemLabel={labelOf(item)}
            range={rangeOf(itemId)}
            heights={heights}
            activeIndex={activeIndex}
            hoverIndex={hoverIndex}
            translation={translation}
            onMeasured={onMeasured}
            onDrop={onDrop}
            handlePlacement={handlePlacement}
            handleAppearance={handleAppearance}
          >
            {renderItem(item, index)}
          </ReorderableRow>
        );
      })}
    </Animated.View>
  );
}
