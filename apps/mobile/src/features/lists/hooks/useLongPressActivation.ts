import { useCallback, useRef } from 'react';

/** Suppresses only the synthetic press belonging to the long-press gesture itself. */
export function useLongPressActivation(onActivate: () => void) {
  const longPressed = useRef(false);

  const markLongPress = useCallback(() => {
    longPressed.current = true;
  }, []);

  const dismissActions = useCallback(() => {
    longPressed.current = false;
  }, []);

  const activate = useCallback(() => {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    onActivate();
  }, [onActivate]);

  return { activate, dismissActions, markLongPress } as const;
}
