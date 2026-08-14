import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * How much of the viewport the software keyboard is currently covering, in points. `0` when it
 * is closed.
 *
 * **This exists so no screen ever computes a keyboard offset again** (`design-system.md` §0,
 * ownership). A screen that does its own keyboard maths ends up with an unexplained
 * `keyboardVerticalOffset = 86` that is right on one device and wrong on the next; the two
 * containers that own layout — `ScreenShell` and `Sheet` — consume this instead, so a field near
 * the bottom of either is reachable without the screen knowing a keyboard exists.
 *
 * iOS uses the `Will` events so the layout moves with the keyboard rather than after it; Android
 * only emits `Did`. There is a `.web.ts` fork alongside this file — React Native Web's
 * `Keyboard` module never fires, and the browser reports the same thing through
 * `visualViewport`.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const showEvent =
      Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const shown = Keyboard.addListener(showEvent, (event) => {
      setInset(event.endCoordinates?.height ?? 0);
    });
    const hidden = Keyboard.addListener(hideEvent, () => setInset(0));

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return inset;
}
