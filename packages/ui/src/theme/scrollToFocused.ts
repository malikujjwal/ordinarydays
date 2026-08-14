import { type RefObject, useEffect } from 'react';
import { Platform, type ScrollView, TextInput } from 'react-native';

/** Breathing room between the focused field and the top of the keyboard. */
const GAP = 16;

/**
 * Scrolls the focused input out from under the keyboard — **on Android only**.
 *
 * iOS has `automaticallyAdjustKeyboardInsets`, and a browser scrolls a focused element into view
 * by itself. Android has neither: the inset its container adds makes the field *reachable*, but
 * nothing moves it, so the user is left scrolling blind for their own caret. That is §20's named
 * failure, and this closes it in the two containers that own layout rather than in each screen.
 *
 * It measures rather than assumes, and **only scrolls when the field is actually occluded** —
 * §20 again: "do not scroll when the field is already clearly visible, do not jump the entire
 * screen unnecessarily". It re-runs whenever the inset changes, which is also what makes it
 * correct after a validation message appears and moves the field.
 */
export function useScrollToFocusedInput(
  scrollRef: RefObject<ScrollView | null>,
  keyboardInset: number,
  /** The container's own visible height, so occlusion can be judged against it. */
  viewportHeight: number,
): void {
  useEffect(() => {
    if (Platform.OS !== 'android' || keyboardInset <= 0) return;

    const scroll = scrollRef.current;
    const focused = TextInput.State.currentlyFocusedInput();
    if (scroll === null || focused === null) return;

    /**
     * A frame's grace before measuring: the inset arrives with `keyboardDidShow`, and the
     * layout it implies has not necessarily been applied yet.
     */
    const timer = setTimeout(() => {
      focused.measureLayout(
        scroll.getScrollableNode() as number,
        (_x: number, y: number, _width: number, height: number) => {
          const visible = viewportHeight - keyboardInset;
          const bottom = y + height;
          if (bottom <= visible - GAP) return;
          scroll.scrollTo({ y: bottom - visible + GAP, animated: true });
        },
        () => {},
      );
    }, 0);

    return () => clearTimeout(timer);
  }, [keyboardInset, scrollRef, viewportHeight]);
}
