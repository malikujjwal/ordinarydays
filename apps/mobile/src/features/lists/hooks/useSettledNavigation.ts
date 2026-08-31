import { interactionTiming } from '@od/ui';
import { useCallback, useEffect, useRef } from 'react';

/**
 * Runs a List navigation after the press visual has returned to rest.
 *
 * React Navigation snapshots the outgoing screen synchronously. Opening a route from the
 * Pressable callback can therefore freeze the row at its pressed opacity and replay the
 * release when the user comes back. One animation frame is enough for Pressable to publish
 * its resting style. A short post-navigation lock coalesces a physical double tap/click even
 * when its two click events straddle animation frames.
 */
export function useSettledNavigation<T>(
  navigate: (value: T) => void,
): (value: T) => void {
  const pending = useRef(false);
  const frame = useRef<number | undefined>(undefined);
  const unlock = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      if (unlock.current !== undefined) clearTimeout(unlock.current);
    },
    [],
  );

  return useCallback(
    (value: T) => {
      if (pending.current) return;
      pending.current = true;
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        try {
          navigate(value);
        } catch (error) {
          pending.current = false;
          throw error;
        }
        unlock.current = setTimeout(() => {
          pending.current = false;
          unlock.current = undefined;
        }, interactionTiming.duplicateActivationWindow);
      });
    },
    [navigate],
  );
}
