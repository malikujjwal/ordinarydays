import { type RefObject, useEffect } from 'react';
import { Platform, type ScrollView, TextInput } from 'react-native';

/** Breathing room between the focused field and the top of the keyboard. */
const GAP = 16;

/**
 * Scrolls an occluded input above the keyboard and any fixed footer.
 *
 * iOS automatic insets do not account for a fixed footer, and double-count a container that has
 * already lifted clear of the keyboard; those cases pass `footerHeight` and use the native
 * scroll responder after measuring occlusion. Android has no automatic correction: the inset its container adds makes the field *reachable*, but
 * nothing moves it, so the user is left scrolling blind for their own caret. That is §20's named
 * failure, and this closes it in the two containers that own layout rather than in each screen.
 *
 * It measures rather than assumes, and **only scrolls when the field is actually occluded** —
 * §20 again: "do not scroll when the field is already clearly visible, do not jump the entire
 * screen unnecessarily". It re-runs whenever the inset changes, which is also what makes it
 * correct after a validation message appears and moves the field.
 */
export function useScrollToFocusedInput(
  scrollRef: RefObject<Pick<
    ScrollView,
    | 'getNativeScrollRef'
    | 'getScrollableNode'
    | 'scrollTo'
    | 'scrollResponderScrollNativeHandleToKeyboard'
  > | null>,
  keyboardInset: number,
  /** The container's own visible height, so occlusion can be judged against it. */
  viewportHeight: number,
  /** Re-measure when rapid entry or validation changes content above the focused field. */
  contentHeight = 0,
  footerHeight = 0,
): void {
  useEffect(() => {
    // Reading the measured size makes insertion itself a remeasurement trigger while the same
    // input retains focus; the value is not part of the offset calculation.
    void contentHeight;
    if (keyboardInset <= 0 || (Platform.OS !== 'android' && footerHeight <= 0)) return;

    const scroll = scrollRef.current;
    const focused = TextInput.State.currentlyFocusedInput();
    if (scroll === null || focused === null) return;

    if (Platform.OS === 'ios') {
      const frame = requestAnimationFrame(() => {
        focused.measureInWindow((_x, y, _width, height) => {
          if (y + height <= viewportHeight - keyboardInset - footerHeight - GAP) return;
          /**
           * **React Native's keyboard scroll assumes the scroll view starts at the top of the
           * window** — its own comment says so: it measures the field against the content and
           * the keyboard against the screen. A lifted `Sheet` body, or a `ScreenShell` body under
           * a header, starts lower, and without its window top the field lands that many points
           * short of the target — still under the footer. The measurement runs after the lift
           * has been laid out, so `viewportHeight - keyboardInset - footerHeight` is the body's
           * visible bottom and the offset below is measured against the same layout.
           */
          const scrollHost = scroll.getNativeScrollRef();
          const scrollToKeyboard = (scrollTop: number) =>
            scroll.scrollResponderScrollNativeHandleToKeyboard(
              focused,
              scrollTop + footerHeight + GAP,
              true,
            );
          if (scrollHost === null) {
            scrollToKeyboard(0);
            return;
          }
          scrollHost.measureInWindow((_sx, scrollTop) => scrollToKeyboard(scrollTop));
        });
      });
      return () => cancelAnimationFrame(frame);
    }

    /**
     * A frame's grace before measuring: the inset arrives with `keyboardDidShow`, and the
     * layout it implies has not necessarily been applied yet.
     */
    const timer = setTimeout(() => {
      focused.measureLayout(
        scroll.getScrollableNode() as number,
        (_x: number, y: number, _width: number, height: number) => {
          const visible = viewportHeight - keyboardInset - footerHeight;
          const bottom = y + height;
          if (bottom <= visible - GAP) return;
          scroll.scrollTo({ y: bottom - visible + GAP, animated: true });
        },
        () => {},
      );
    }, 0);

    return () => clearTimeout(timer);
  }, [contentHeight, footerHeight, keyboardInset, scrollRef, viewportHeight]);
}
